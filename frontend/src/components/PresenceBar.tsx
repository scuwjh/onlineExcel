import type { Cursor } from "../types";

interface Props {
  users: Record<string, boolean>;
  cursors: Record<string, Cursor>;
  self: string;
}

export default function PresenceBar({ users, cursors, self }: Props) {
  const online = Object.keys(users).filter((u) => users[u]);
  return (
    <div className="presence-bar">
      <span className="presence-title">在线用户（{online.length}）：</span>
      {online.length === 0 && <span className="muted">暂无其他人</span>}
      {online.map((u) => {
        const c = cursors[u];
        return (
          <span key={u} className="presence-user">
            {u === self ? "我" : u}
            {c ? ` @${c.row + 1},${c.col + 1}` : ""}
          </span>
        );
      })}
    </div>
  );
}
