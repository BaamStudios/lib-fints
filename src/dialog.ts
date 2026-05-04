import { TanMediaRequirement, TanProcess } from './codes.js';
import type { FinTSConfig } from './config.js';
import { HttpClient } from './httpClient.js';
import {
	type ClientResponse,
	type CustomerInteraction,
	CustomerOrderInteraction,
} from './interactions/customerInteraction.js';
import { EndDialogInteraction } from './interactions/endDialogInteraction.js';
import { InitDialogInteraction } from './interactions/initDialogInteraction.js';
import { CustomerMessage, CustomerOrderMessage, type Message } from './message.js';
import { PARTED, type PartedSegment } from './partedSegment.js';
import type { SegmentWithContinuationMark } from './segment.js';
import { decode } from './segment.js';
import { HKEND } from './segments/HKEND.js';
import { HKTAN, type HKTANSegment } from './segments/HKTAN.js';
import { HNHBK, type HNHBKSegment } from './segments/HNHBK.js';

export class Dialog {
	dialogId: string = '0';
	lastMessageNumber = 0;
	interactions: CustomerInteraction[] = [];
	responses: Map<string, ClientResponse> = new Map();
	currentInteractionIndex = 0;
	isInitialized = false;
	hasEnded = false;
	httpClient: HttpClient;

	constructor(
		public config: FinTSConfig,
		syncSystemId: boolean = false,
	) {
		if (!this.config) {
			throw new Error('configuration must be provided');
		}

		this.httpClient = this.getHttpClient();
		this.interactions.push(new InitDialogInteraction(this.config, syncSystemId));
		this.interactions.push(new EndDialogInteraction());
		this.interactions.forEach((interaction) => {
			interaction.dialog = this;
		});
	}

	get currentInteraction(): CustomerInteraction {
		return this.interactions[this.currentInteractionIndex];
	}

	async start(): Promise<Map<string, ClientResponse>> {
		if (this.isInitialized) {
			throw new Error('dialog has already been initialized');
		}

		if (this.hasEnded) {
			throw Error('cannot start a dialog that has already ended');
		}

		if (this.lastMessageNumber > 0) {
			throw new Error('dialog start can only be called on a new dialog');
		}

		let clientResponse: ClientResponse;

		do {
			const message = this.createCurrentCustomerMessage();
			const responseMessage = await this.httpClient.sendMessage(message);
			await this.handlePartedMessages(message, responseMessage, this.currentInteraction);
			clientResponse = this.currentInteraction.handleClientResponse(responseMessage);
			// Note: pagination on the initial-call path doesn't get a TAN orderRef.
			// If the bank requires SCA per HKKAZ, the first response itself is a
			// HITAN/3955 — pagination only happens later via Dialog.continue.
			this.checkEnded(clientResponse);
			this.dialogId = clientResponse.dialogId;
			this.responses.set(this.currentInteraction.segId, clientResponse);

			if (clientResponse.success && !clientResponse.requiresTan) {
				this.currentInteractionIndex++;

				if (this.currentInteractionIndex > 0) {
					this.isInitialized = true;
				}
			}
		} while (
			!this.hasEnded &&
			this.currentInteractionIndex < this.interactions.length &&
			clientResponse.success &&
			!clientResponse.requiresTan
		);

		return this.responses;
	}

	async continue(tanOrderReference: string, tan?: string): Promise<Map<string, ClientResponse>> {
		if (!tanOrderReference) {
			throw Error('tanOrderReference must be provided to continue a customer order with a TAN');
		}

		if (!this.config.selectedTanMethod?.isDecoupled && !tan) {
			throw Error('TAN must be provided for non-decoupled TAN methods');
		}

		if (this.hasEnded) {
			throw Error('cannot continue a customer order when dialog has already ended');
		}

		if (!this.currentInteraction) {
			throw new Error('there is no running customer interaction in this dialog to continue');
		}

		let clientResponse: ClientResponse;

		let isFirstMessage = true;

		do {
			const message = isFirstMessage
				? this.createCurrentTanMessage(tanOrderReference, tan)
				: this.createCurrentCustomerMessage();
			const responseMessage = await this.httpClient.sendMessage(message);
			await this.handlePartedMessages(
				message,
				responseMessage,
				this.currentInteraction,
				tanOrderReference,
			);
			clientResponse = this.currentInteraction.handleClientResponse(responseMessage);
			this.checkEnded(clientResponse);
			this.dialogId = clientResponse.dialogId;
			this.responses.set(this.currentInteraction.segId, clientResponse);

			if (clientResponse.success && !clientResponse.requiresTan) {
				this.currentInteractionIndex++;

				if (this.currentInteractionIndex > 0) {
					this.isInitialized = true;
				}
			}

			isFirstMessage = false;
		} while (
			!this.hasEnded &&
			this.currentInteractionIndex < this.interactions.length &&
			clientResponse.success &&
			!clientResponse.requiresTan
		);

		return this.responses;
	}

	addCustomerInteraction(interaction: CustomerInteraction, afterCurrent = false): void {
		if (this.hasEnded) {
			throw Error('cannot queue another customer interaction when dialog has already ended');
		}

		const isCustomerOrder = interaction instanceof CustomerOrderInteraction;

		if (isCustomerOrder && !this.config.isTransactionSupported(interaction.segId)) {
			throw Error(
				`customer order transaction ${interaction.segId} is not supported according to the BPD`,
			);
		}

		interaction.dialog = this;

		if (afterCurrent) {
			this.interactions.splice(this.currentInteractionIndex + 1, 0, interaction);
			return;
		}

		this.interactions.splice(this.interactions.length - 1, 0, interaction);
	}

	private createCurrentCustomerMessage(): CustomerMessage {
		this.lastMessageNumber++;

		const isCustomerOrder = this.currentInteraction instanceof CustomerOrderInteraction;
		const message = isCustomerOrder
			? new CustomerOrderMessage(
					this.currentInteraction.segId,
					this.currentInteraction.responseSegId,
					this.dialogId,
					this.lastMessageNumber,
				)
			: new CustomerMessage(this.dialogId, this.lastMessageNumber);

		const tanMethod = this.config.selectedTanMethod;
		const isScaSupported = tanMethod && tanMethod.version >= 6;
		let isTanMethodNeeded = isScaSupported && this.currentInteraction.segId !== HKEND.Id;

		if (isCustomerOrder) {
			const bankTransaction = this.config.bankingInformation.bpd?.allowedTransactions.find(
				(t) => t.transId === this.currentInteraction.segId,
			);

			isTanMethodNeeded = isTanMethodNeeded && bankTransaction?.tanRequired;
		}

		if (this.config.userId && this.config.pin) {
			message.sign(
				this.config.countryCode,
				this.config.bankId,
				this.config.userId,
				this.config.pin,
				this.config.bankingInformation.systemId,
				isScaSupported ? this.config.tanMethodId : undefined,
			);
		}

		const segments = this.currentInteraction.getSegments(this.config);
		segments.forEach((segment) => {
			message.addSegment(segment);
		});

		if (this.config.userId && this.config.pin && isTanMethodNeeded) {
			const hktan: HKTANSegment = {
				header: { segId: HKTAN.Id, segNr: 0, version: tanMethod?.version ?? 0 },
				tanProcess: TanProcess.Process4,
				segId: this.currentInteraction.segId,
			};

			message.addSegment(hktan);
		}

		return message;
	}

	private createCurrentTanMessage(tanOrderReference: string, tan?: string): CustomerMessage {
		this.lastMessageNumber++;

		// When the current interaction is a customer order, build the TAN-continue
		// message as a CustomerOrderMessage so the response is decoded with the
		// `orderResponseSegId` and the order response segment (e.g. HIKAZ) is
		// wrapped as a PARTED segment. Without this, a continuation indicator
		// (return code 3040) on the TAN-continue response is silently dropped
		// because handlePartedMessages only acts on PARTED segments.
		const interaction = this.currentInteraction;
		const isCustomerOrder = interaction instanceof CustomerOrderInteraction;
		const message: CustomerMessage = isCustomerOrder
			? new CustomerOrderMessage(
					interaction.segId,
					interaction.responseSegId,
					this.dialogId,
					this.lastMessageNumber,
				)
			: new CustomerMessage(this.dialogId, this.lastMessageNumber);

		if (this.config.userId && this.config.pin) {
			message.sign(
				this.config.countryCode,
				this.config.bankId,
				this.config.userId,
				this.config.pin,
				this.config.bankingInformation?.systemId,
				this.config.tanMethodId,
				tan,
			);
		}

		if (this.config.userId && this.config.pin && this.config.tanMethodId) {
			const hktan: HKTANSegment = {
				header: { segId: HKTAN.Id, segNr: 0, version: this.config.selectedTanMethod?.version ?? 0 },
				tanProcess: this.config.selectedTanMethod?.isDecoupled
					? TanProcess.Status
					: TanProcess.Process2,
				segId: this.currentInteraction.segId,
				orderRef: tanOrderReference,
				nextTan: false,
				tanMedia:
					(this.config.selectedTanMethod?.tanMediaRequirement ??
					TanMediaRequirement.NotAllowed >= TanMediaRequirement.Optional)
						? this.config.tanMediaName
						: undefined,
			};

			message.addSegment(hktan);
		}
		return message;
	}

	private async handlePartedMessages(
		message: CustomerMessage,
		responseMessage: Message,
		interaction: CustomerInteraction,
		tanOrderReference?: string,
	) {
		let partedSegment = responseMessage.findSegment<PartedSegment>(PARTED.Id);

		if (partedSegment) {
			let currentRequestMessage: CustomerMessage = message;

			while (responseMessage.hasReturnCode(3040)) {
				const answers = responseMessage.getBankAnswers();
				const answer = answers.find((a) => a.code === 3040);

				if (!answer || !answer.params || answer.params.length === 0) {
					throw new Error(
						'Expected bank answer to contain continuation mark parameters (code 3040)',
					);
				}

				const continuationMark = answer.params[0];

				const existingSegmentWithContinuation = currentRequestMessage.segments.find(
					(s) => s.header.segId === interaction.segId,
				) as SegmentWithContinuationMark | undefined;

				let nextRequestMessage: CustomerMessage;

				if (existingSegmentWithContinuation) {
					// Original path: the previous request already contained the order
					// segment (e.g. HKKAZ). Mutate it in place and resend with a fresh
					// message number.
					existingSegmentWithContinuation.continuationMark = continuationMark;
					const hnhbkSegment = currentRequestMessage.findSegment<HNHBKSegment>(HNHBK.Id);
					if (!hnhbkSegment) {
						throw new Error('HNHBK segment not found in message');
					}
					hnhbkSegment.msgNr = ++this.lastMessageNumber;
					nextRequestMessage = currentRequestMessage;
				} else {
					// New path: the previous request was a TAN-continue (HKTAN-only)
					// message and contained no order segment we could mutate. Build a
					// fresh order message that carries the continuation mark, signed in
					// the still-authenticated dialog. Without this branch, lib-fints
					// silently dropped continuation hints from the TAN-continue
					// response — see issue around large fetches against Sparkassen
					// where the first 100 bookings arrived but the rest never did.
					if (!(interaction instanceof CustomerOrderInteraction)) {
						throw new Error(
							`Response contains segment with further information, but corresponding segment could not be found or is not specified`,
						);
					}
					nextRequestMessage = this.createContinuationMessage(
						interaction,
						continuationMark,
						tanOrderReference,
					);
				}

				const nextResponseMessage = await this.httpClient.sendMessage(nextRequestMessage);
				const nextPartedSegment = nextResponseMessage.findSegment<PartedSegment>(PARTED.Id);

				if (!nextPartedSegment) {
					// The bank refused to deliver more data on this continuation. The
					// most common reason against PIN/TAN banks is that every HKKAZ
					// request — including a pure pagination continuation — is gated by
					// SCA (return code 9370 "Anzahl Signaturen für diesen Auftrag
					// unzureichend"), so handing pagination off through a synchronous
					// loop is impossible. Stop the loop and keep the previously
					// received parts so the caller still gets a partial result. The
					// surviving 3040 in `responseMessage` signals to upstream that the
					// result is incomplete; the caller can decide whether to issue a
					// fresh, separately authenticated continuation request.
					break;
				}

				nextPartedSegment.rawData =
					partedSegment.rawData +
					nextPartedSegment.rawData.slice(nextPartedSegment.rawData.indexOf('+') + 1);
				partedSegment = nextPartedSegment;

				currentRequestMessage = nextRequestMessage;
				responseMessage = nextResponseMessage;
			}

			const completeSegment = decode(partedSegment.rawData);
			const index = responseMessage.segments.indexOf(partedSegment);
			if (index >= 0) {
				responseMessage.segments.splice(index, 1, completeSegment);
			} else {
				// The PARTED carrier was attached to a previous response (e.g. the
				// initial TAN-continue answer) and is no longer present in the final
				// continuation answer. Append the assembled segment so downstream
				// handlers (e.g. StatementInteractionMT940#handleResponse) can find it.
				responseMessage.segments.push(completeSegment);
			}
		}
	}

	private createContinuationMessage(
		interaction: CustomerOrderInteraction,
		continuationMark: string,
		tanOrderReference?: string,
	): CustomerOrderMessage {
		this.lastMessageNumber++;
		const message = new CustomerOrderMessage(
			interaction.segId,
			interaction.responseSegId,
			this.dialogId,
			this.lastMessageNumber,
		);

		if (this.config.userId && this.config.pin) {
			message.sign(
				this.config.countryCode,
				this.config.bankId,
				this.config.userId,
				this.config.pin,
				this.config.bankingInformation.systemId,
				this.config.tanMethodId,
			);
		}

		const segments = interaction.getSegments(this.config);
		for (const segment of segments) {
			if (segment.header.segId === interaction.segId) {
				(segment as SegmentWithContinuationMark).continuationMark = continuationMark;
			}
			message.addSegment(segment);
		}

		// Opt-in: when the bank flags every business transaction as tanRequired
		// but signals `multipleTans: true` and `tanDialogOptions: 2` for the
		// active TAN method, a paginated continuation can be authorized by the
		// already-confirmed TAN if the request carries an HKTAN that references
		// the original TAN's orderRef (tanProcess: 2). Without this segment
		// banks like Sparkasse Hildesheim reject the continuation with code
		// 9370 "Anzahl Signaturen für diesen Auftrag unzureichend".
		if (
			this.config.reuseTanForPagination &&
			tanOrderReference &&
			this.config.userId &&
			this.config.pin &&
			this.config.tanMethodId
		) {
			const hktan: HKTANSegment = {
				header: {
					segId: HKTAN.Id,
					segNr: 0,
					version: this.config.selectedTanMethod?.version ?? 0,
				},
				tanProcess: TanProcess.Process2,
				segId: interaction.segId,
				orderRef: tanOrderReference,
				nextTan: false,
			};
			message.addSegment(hktan);
		}

		return message;
	}

	private checkEnded(response: ClientResponse) {
		if (
			response.bankAnswers.some((answer) => answer.code === 100) ||
			response.bankAnswers.some((answer) => answer.code === 9000)
		) {
			this.hasEnded = true;
		}
	}

	private getHttpClient(): HttpClient {
		return new HttpClient(this.config.bankingUrl, this.config.debugEnabled);
	}
}
