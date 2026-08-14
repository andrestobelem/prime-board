// Campos compartidos por las vistas de issues.
export const ISSUE_LIST_FIELDS = `
  id identifier title priority
  state { id name type color position }
  assignee { id name type }
  labels { id name color }
  project { id name }
`;
