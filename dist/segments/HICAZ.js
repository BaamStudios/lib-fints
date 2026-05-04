import { Binary } from '../dataElements/Binary.js';
import { Text } from '../dataElements/Text.js';
import { DataGroup } from '../dataGroups/DataGroup.js';
import { InternationalAccountGroup, } from '../dataGroups/InternationalAccount.js';
import { SegmentDefinition } from '../segmentDefinition.js';
/**
 * Account transactions within period response (CAMT format)
 */
export class HICAZ extends SegmentDefinition {
    static Id = 'HICAZ';
    static Version = 1;
    constructor() {
        super(HICAZ.Id);
    }
    version = HICAZ.Version;
    elements = [
        new InternationalAccountGroup('account', 1, 1),
        new Text('camtDescriptor', 1, 1), // camt-Descriptor (single format used)
        // `Binary` constructor signature is (name, minCount, maxCount, maxLength).
        // Earlier versions of this file passed `99` here, which the decoder
        // interpreted as "stop after 99 messages" — fine for short statements,
        // but a long account-statement query against an active account can
        // easily produce hundreds of per-day CAMT reports, and everything
        // past the 99th was silently discarded. Use Number.MAX_SAFE_INTEGER
        // like HIKAZ does for the equivalent MT940 buffer.
        new DataGroup('bookedTransactions', [new Binary('camtMessage', 1, Number.MAX_SAFE_INTEGER)], 1, 1), // Booked CAMT transactions
        new DataGroup('notedTransactions', [new Binary('camtMessage', 1, Number.MAX_SAFE_INTEGER)], 0, 1), // Noted CAMT transactions
    ];
}
