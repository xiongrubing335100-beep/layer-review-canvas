import { ArrowLeft } from 'lucide-react';

export function WorkspaceHeading({ title, detail, actions, level = 1 }) {
  const Heading = level === 2 ? 'h2' : 'h1';
  return <header className="v2-workspace-heading">
    <div className="v2-workspace-heading__title"><Heading>{title}</Heading>{detail ? <span title={detail}>{detail}</span> : null}</div>
    {actions ? <div className="v2-workspace-heading__actions">{actions}</div> : null}
  </header>;
}

export function WorkspaceBack({ onClick, label = '返回画布' }) {
  return <button className="v2-workspace-back" type="button" aria-label={label} title={label} onClick={onClick}><ArrowLeft size={14}/>返回</button>;
}

export function WorkspaceFooter({ status, children }) {
  return <footer className="v2-workspace-footer">
    <div className="v2-workspace-footer__status">{status}</div>
    <div className="v2-workspace-footer__actions">{children}</div>
  </footer>;
}
