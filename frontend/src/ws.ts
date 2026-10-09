export interface WsMessage {
  type: string;
  [key: string]: unknown;
}

export interface WsHandlers {
  onOpen?: () => void;
  onMessage: (msg: WsMessage) => void;
  onClose?: () => void;
}

export function connectWS(
  sheetId: string,
  user: string,
  handlers: WsHandlers,
): { socket: WebSocket; close: () => void } {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${window.location.host}/ws/sheets/${sheetId}?user=${encodeURIComponent(user)}`;
  const ws = new WebSocket(url);

  ws.onopen = () => handlers.onOpen?.();
  ws.onmessage = (evt) => {
    try {
      handlers.onMessage(JSON.parse(evt.data) as WsMessage);
    } catch {
      // 忽略非 JSON 消息
    }
  };
  ws.onclose = () => handlers.onClose?.();

  return { socket: ws, close: () => ws.close() };
}

export function send(ws: WebSocket | null, msg: WsMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}
