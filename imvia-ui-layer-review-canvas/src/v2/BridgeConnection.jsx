import { useEffect, useRef, useState } from 'react';
import { Link2, LoaderCircle, Copy, X } from 'lucide-react';
import { createBridgeRecovery, bridgeReceiptDeadline } from './bridge-recovery.js';

export function BridgeConnection({ api, documentId, workspaceId }) {
  const [status, setStatus] = useState(null);
  const [help, setHelp] = useState(false);
  const [message, setMessage] = useState('');
  const [waiting, setWaiting] = useState(false);
  const [statusError, setStatusError] = useState(false);
  const request = useRef({ posting: false, deadline: 0, epoch: 0 });
  const alive = useRef(true);
  const connectionState = statusError ? 'is-offline' : !documentId || waiting || !status ? 'is-pending' : status.online ? 'is-online' : 'is-offline';
  const reason = statusError ? '本地连接服务暂时不可用，请检查工作台服务。'
    : status?.autoReconnectBlocked ? '会话桥已切换到另一个文档。需要继续此文档时，可手动重连。'
    : status?.reason === 'binding_mismatch' ? '正在自动恢复当前文档的会话桥连接。'
      : status?.reason === 'heartbeat_expired' ? '会话桥心跳已中断。卡片恢复前台后会自动检查；若卡片已关闭，请在当前对话重开。'
        : status?.online ? '会话桥已连接当前文档。'
          : waiting ? '正在等待当前会话桥的连接回执。'
            : status?.reconnecting ? '尚未收到重连回执。请恢复会话桥卡片，或在当前对话重开。'
            : '当前没有在线会话桥。可以重连已有卡片，或在当前对话重开。';
  const prompt = `请仅修复当前文档的 V2 会话桥连接：调用 open_workbench_v2_bridge，mode="resume"，documentId="${documentId}"，workspaceId="${workspaceId}"。这是明确继续当前文档，不是打开全新工作台。调用前核对右侧当前页面 URL 的 documentId，若已变化请使用页面当前值。保留当前图片、选区和编辑内容，不提交或执行拆分任务。若工具尚未加载，请明确告知。`;

  useEffect(() => {
    alive.current = true;
    request.current = { posting:false, deadline:0, epoch:request.current.epoch + 1 };
    setStatus(null); setStatusError(false); setWaiting(false); setHelp(false); setMessage('');
    let timer, stopped = false, registered = false, refreshing = false;
    const recovery = createBridgeRecovery({ api, documentId, workspaceId });
    async function refresh() {
      if (stopped || refreshing) return;
      clearTimeout(timer);
      refreshing = true;
      const epoch = request.current.epoch;
      if (!request.current.posting && documentId && api.getBridgeStatus) {
        try {
          if (!registered && workspaceId && api.registerBridgeWorkspace) {
            await api.registerBridgeWorkspace(documentId, workspaceId); registered = true;
          }
          let next = await api.getBridgeStatus(documentId, workspaceId);
          if (stopped) return;
          if (epoch !== request.current.epoch) { refreshing = false; timer = setTimeout(refresh, 1500); return; }
          setStatus(next); setStatusError(false);
          if (next.online) {
            setWaiting(false); if (request.current.deadline) setHelp(false);
            setMessage(''); request.current.deadline = 0;
          } else if (request.current.deadline && Date.now() >= request.current.deadline) {
            setWaiting(false); if (request.current.manual) setHelp(true); request.current.deadline = 0;
            setMessage('未收到会话桥回执。卡片可能已关闭，或插件连接不可用。请把下面的请求发送到当前 Codex 对话。');
          }
          if (!request.current.deadline) {
            request.current.posting = true;
            try {
              const recovered = await recovery.recover(next, { visible:globalThis.document.visibilityState !== 'hidden' });
              if (stopped || epoch !== request.current.epoch) return;
              if (recovered) {
                next = recovered; setStatus(next);
                request.current.manual = false;
                request.current.deadline = bridgeReceiptDeadline(next);
                setWaiting(Boolean(request.current.deadline));
                if (request.current.deadline) setMessage('');
              }
            } finally { if (epoch === request.current.epoch) request.current.posting = false; }
          }
        } catch {
          if (stopped) return;
          if (epoch !== request.current.epoch) { refreshing = false; timer = setTimeout(refresh, 1500); return; }
          setStatus(null); setStatusError(true);
          if (request.current.deadline && Date.now() >= request.current.deadline) {
            setWaiting(false); if (request.current.manual) setHelp(true); request.current.deadline = 0;
            setMessage('工作台连接服务暂时不可用。可稍后重连；图片和选区未清空。');
          }
        }
      }
      refreshing = false;
      if (!stopped) timer = setTimeout(refresh, 1500);
    }
    const wake = () => { if (globalThis.document.visibilityState !== 'hidden') void refresh(); };
    window.addEventListener('focus', wake);
    window.addEventListener('pageshow', wake);
    globalThis.document.addEventListener('visibilitychange', wake);
    void refresh();
    return () => {
      stopped = true; alive.current = false; recovery.stop(); clearTimeout(timer);
      window.removeEventListener('focus', wake); window.removeEventListener('pageshow', wake);
      globalThis.document.removeEventListener('visibilitychange', wake);
    };
  }, [api, documentId, workspaceId]);

  async function reconnect() {
    if (request.current.posting || waiting || !documentId) return;
    request.current.posting = true; request.current.manual = true; request.current.epoch++;
    const epoch = request.current.epoch;
    setWaiting(true); setHelp(true); setMessage(''); setStatus(null); setStatusError(false);
    try {
      const next = await api.reconnectBridge(documentId, workspaceId);
      if (!alive.current || request.current.epoch !== epoch) return;
      setStatus(next); request.current.deadline = Date.now() + 10000;
    } catch {
      if (!alive.current || request.current.epoch !== epoch) return;
      setWaiting(false); setHelp(true);
      setMessage('无法发起重连。请确认本地工作台服务可用，或在当前 Codex 对话重开会话桥。');
    } finally { if (request.current.epoch === epoch) request.current.posting = false; }
  }
  async function copyRequest() {
    try { await navigator.clipboard.writeText(prompt); setMessage('已复制。请粘贴到当前 Codex 对话并发送；尚未自动重开会话桥。'); }
    catch { setMessage('无法访问剪贴板，请选中下方请求手动复制到当前 Codex 对话。'); }
  }

  return <div className="v2-bridge-control">
    <span className={`v2-bridge-status ${connectionState}`} role="status" title={documentId ? `${reason}\n当前文档：${documentId}\n桥绑定文档：${status?.boundDocumentId || '尚未绑定'}` : ''}><i aria-hidden="true"/>{!documentId ? '上传后连接' : waiting ? '正在重连…' : statusError ? '连接异常' : status?.online ? '已连接' : status?.reason === 'binding_mismatch' ? '文档未连接' : status ? '未连接' : '检查连接…'}</span>
    <button type="button" className="v2-topbar-action v2-topbar-action--connect" disabled={!documentId} aria-busy={waiting} aria-expanded={help} aria-label={status?.online ? '查看连接详情' : waiting ? '查看重连进度' : '重新连接会话桥'}
      title={documentId ? '连接当前任务的会话桥，保留图片、选区和结果' : '上传图片后可连接当前任务的会话桥'} onClick={() => status?.online || waiting ? setHelp(value => !value) : reconnect()}>
      {waiting ? <LoaderCircle className="v2-spin" size={16}/> : <Link2 size={16}/>}<span>{status?.online ? '连接详情' : waiting ? '连接中…' : '重连'}</span>
    </button>
    {help && <section className="v2-bridge-help" aria-label="重新打开会话桥">
      <header><strong>{status?.online ? '当前文档连接' : '恢复当前文档连接'}</strong><button type="button" aria-label="关闭重连提示" onClick={() => setHelp(false)}><X size={16}/></button></header>
      <p role="status">{message || reason}</p>
      {status?.online ? <small>文档 {documentId}</small> : <>
        <details open={!waiting}><summary>卡片已关闭？在当前对话重开</summary>
          <textarea aria-label="会话桥重连请求" readOnly value={prompt} onFocus={event => event.target.select()}/>
          <button type="button" className="v2-restart" onClick={copyRequest}><Copy size={14}/>复制重连请求</button>
        </details>
      </>}
      <small>此操作只恢复连接，不重新上传，也不重新执行旧任务。</small>
    </section>}
  </div>;
}
