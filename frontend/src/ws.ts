/**
 * WebSocket 协同客户端。
 *
 * 协议（见 docs/api-contract.md）：
 * - 上行：join 由 URL 完成；每条写操作带 ``client_id`` 与 ``version``（版本向量）；
 * - 下行：``welcome``（权威快照）、``cell_update``/``cell_format``、
 *   ``row_insert``/``row_delete``/``col_insert``/``col_delete``（带权威投影）、
 *   ``presence``/``cursor``/``error``。
 *
 * 断线自动重连（指数退避），并把本地未确认的写入排队，重连后按序重放。
 */
import { getToken } from "./api";
import type { CellFormat, Role } from "./types";

export interface WsMessage {
  type: string;
  seq?: number;
  /** 下行：服务端版本号（number）；上行：版本向量（Record<clientId, seq>）。 */
  version?: number | Record<string, number>;
  role?: Role;
  client_id?: string;
  counter?: number;
  element_id?: string;
  user?: string;
  row?: number;
  col?: number;
  row_id?: string;
  col_id?: string;
  at?: number;
  value?: string | null;
  format?: CellFormat | null;
  cells?: Record<string, string | null>;
  formats?: Record<string, CellFormat>;
  rowIds?: string[];
  colIds?: string[];
  rows?: number;
  cols?: number;
  users?: string[];
  online?: boolean;
  /** 服务端因消息过大而拒绝附带全量投影时置位，客户端应改用 REST 拉取。 */
  reload?: boolean;
  /** 评论广播（REQ-100）。 */
  comment?: Record<string, unknown>;
  counts?: Record<string, number>;
  mentions?: string[];
  body?: string;
  code?: string;
  message?: string;
  [key: string]: unknown;
}

export interface WsHandlers {
  onMessage: (msg: WsMessage) => void;
  onStatus?: (status: "connecting" | "open" | "closed") => void;
  onFatal?: (reason: string) => void;
}

export interface WsClient {
  send: (msg: WsMessage) => void;
  close: () => void;
  readonly readyState: number;
}

const MAX_QUEUE = 200;

export function connectWS(sheetId: string, handlers: WsHandlers): WsClient {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  let socket: WebSocket | null = null;
  let closed = false;
  let attempts = 0;
  const queue: WsMessage[] = [];
  let timer: number | undefined;

  function url(): string {
    const token = getToken() ?? "";
    return `${proto}://${window.location.host}/ws/sheets/${sheetId}?token=${encodeURIComponent(token)}`;
  }

  function open(): void {
    if (closed) return;
    handlers.onStatus?.("connecting");
    const ws = new WebSocket(url());
    socket = ws;

    ws.onopen = () => {
      attempts = 0;
      handlers.onStatus?.("open");
      while (queue.length) {
        const msg = queue.shift();
        if (msg) ws.send(JSON.stringify(msg));
      }
    };
    ws.onmessage = (evt) => {
      try {
        handlers.onMessage(JSON.parse(evt.data as string) as WsMessage);
      } catch {
        /* 忽略非 JSON 消息 */
      }
    };
    ws.onclose = (evt) => {
      socket = null;
      handlers.onStatus?.("closed");
      if (closed) return;
      if (evt.code === 4401 || evt.code === 4403 || evt.code === 4404) {
        handlers.onFatal?.(evt.reason || `连接被拒绝（${evt.code}）`);
        return;
      }
      attempts += 1;
      const delay = Math.min(8000, 400 * 2 ** Math.min(attempts, 5));
      timer = window.setTimeout(open, delay);
    };
    ws.onerror = () => {
      /* onclose 会紧随其后，这里不重复处理 */
    };
  }

  open();

  return {
    send(msg: WsMessage) {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(msg));
      } else if (queue.length < MAX_QUEUE) {
        queue.push(msg);
      }
    },
    close() {
      closed = true;
      if (timer) window.clearTimeout(timer);
      socket?.close();
    },
    get readyState() {
      return socket ? socket.readyState : WebSocket.CLOSED;
    },
  };
}
