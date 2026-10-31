import { commitEditorDraft } from './editor-state.js';

// A board split must use the latest requirements, including an open editor draft.
// Do not create a batch if the draft cannot be validated or persisted.
export async function prepareSplitDocument(document, draft, saveDocument) {
  if (!draft) return document;
  const next = commitEditorDraft(document, draft);
  if (next === document) return document;
  const saved = await saveDocument(next, document.revision);
  if (saved.documentId !== next.documentId || saved.revision !== next.revision) throw new Error('保存后的文档或修订号不匹配');
  return saved;
}
