export function workbenchShellStructure(documentCount) {
  return {
    topbar: { gridRow: 1 },
    switcher: documentCount > 1 ? 2 : null,
    workspace: { gridRow: 3 },
  };
}
