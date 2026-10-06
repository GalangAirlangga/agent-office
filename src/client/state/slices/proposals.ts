import type { ProposalState } from '../../../shared/protocol';
import type { Slice } from '../store';

declare module '../store' {
  interface Store { proposals: ProposalState }
  interface Topics { proposals: true }
}

export const proposals: Slice = {
  init(s) { s.proposals = { proposals: [] }; },
  on: {
    proposals(s, m) { s.proposals = m.state; return ['proposals']; },
  },
  enter(s, v) { s.proposals = v.proposals; return ['proposals']; },
};
