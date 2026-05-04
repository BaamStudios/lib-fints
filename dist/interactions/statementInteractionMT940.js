import { Mt940Parser } from '../mt940parser.js';
import { HIKAZ } from '../segments/HIKAZ.js';
import { HKKAZ } from '../segments/HKKAZ.js';
import { CustomerOrderInteraction } from './customerInteraction.js';
export class StatementInteractionMT940 extends CustomerOrderInteraction {
    accountNumber;
    from;
    to;
    continuationMark;
    constructor(accountNumber, from, to, continuationMark) {
        super(HKKAZ.Id, HIKAZ.Id);
        this.accountNumber = accountNumber;
        this.from = from;
        this.to = to;
        this.continuationMark = continuationMark;
    }
    createSegments(init) {
        const bankAccount = init.getBankAccount(this.accountNumber);
        const account = { ...bankAccount, iban: undefined };
        const version = init.getMaxSupportedTransactionVersion(HKKAZ.Id);
        if (!version) {
            throw Error(`There is no supported version for business transaction '${HKKAZ.Id}'`);
        }
        const hkkaz = {
            header: { segId: HKKAZ.Id, segNr: 0, version: version },
            account,
            allAccounts: false,
            from: this.from,
            to: this.to,
            continuationMark: this.continuationMark,
        };
        return [hkkaz];
    }
    handleResponse(response, clientResponse) {
        const hikaz = response.findSegment(HIKAZ.Id);
        if (hikaz?.bookedTransactions) {
            try {
                const parser = new Mt940Parser(hikaz.bookedTransactions);
                clientResponse.statements = parser.parse();
            }
            catch (error) {
                console.warn('MT940 parsing failed:', error);
                clientResponse.statements = [];
            }
        }
        else {
            clientResponse.statements = [];
        }
    }
}
