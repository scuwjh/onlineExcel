import type { Cursor } from "../types";

interface Props {
  users: Record<string, boolean>;
  cursors: Record<string, Cursor>;
  self: string;
}

export default function PresenceBar({ users, cursors, self }: Props) {
  const online = Object.keys(users).filter((u) => users[u]);
  const others = online.filter((u) => u !== self);
  return (
    <div className="presence-bar">
      <span className="presence-title">在线（{online.length}）：</span>
      <span className="presence-user me">我</span>
      {others.length === 0 && <span className="muted">暂无其他人</span>}
      {others.map((u) => {
        const c = cursors[u];
        return (
          <span key={u} className="presence-user">
            {u}
            {c ? ` @${c.row + 1},${c.col + 1}` : ""}
          </span>
        );
      })}
    </div>
  );
}
