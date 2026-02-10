export default class ProposalsDatabase {
  constructor() {
    this.proposals = [];
  }

  addProposal(proposal) {
    return proposal;
  }

  getProposals() {
    return this.proposals;
  }

  getProposal(id) {
    return null;
  }

  updateProposal(id, data) {
    return data;
  }

  deleteProposal(id) {
    return true;
  }
}
