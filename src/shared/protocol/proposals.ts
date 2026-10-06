export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'failed' | 'done';

export interface ProposalTask {
  id: string;
  prompt: string;
  role: string;
  target?: string;
  status: 'pending' | 'assigned' | 'done' | 'failed';
  error?: string;
}

export interface Proposal {
  id: string;
  source: 'user' | 'github-issue';
  sourceKey: string;
  issue?: number;
  title: string;
  input: string;
  tasks: ProposalTask[];
  status: ProposalStatus;
  createdBy: string;
  approvedBy?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProposalState {
  proposals: Proposal[];
}

export type ProposalClientMsg =
  | { t: 'proposal.create'; title: string; input: string; role?: string; issue?: number }
  | { t: 'proposal.approve'; proposalId: string }
  | { t: 'proposal.reject'; proposalId: string; reason?: string };

export type ProposalServerMsg = { t: 'proposals'; state: ProposalState; roles?: { id: string; skills: string[] }[] };
