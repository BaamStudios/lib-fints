import type { FinTSConfig } from '../config.js';
import type { Message } from '../message.js';
import type { Segment } from '../segment.js';
import { CustomerOrderInteraction, type StatementResponse } from './customerInteraction.js';
export declare class StatementInteractionMT940 extends CustomerOrderInteraction {
    accountNumber: string;
    from?: Date | undefined;
    to?: Date | undefined;
    continuationMark?: string | undefined;
    constructor(accountNumber: string, from?: Date | undefined, to?: Date | undefined, continuationMark?: string | undefined);
    createSegments(init: FinTSConfig): Segment[];
    handleResponse(response: Message, clientResponse: StatementResponse): void;
}
//# sourceMappingURL=statementInteractionMT940.d.ts.map