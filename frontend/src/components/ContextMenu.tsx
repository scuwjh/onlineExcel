/**
 * 右键菜单（REQ-005）。
 *
 * 按上下文给出可用操作：
 * - 单元格/选区：剪切、复制、清空内容、清空格式、数字格式、边框、插入/删除行列、数据验证；
 * - 行号：在上方/下方插入行、删除选中行；
 * - 列标：在左侧/右侧插入列、删除选中列。
 *
 * 菜单项由父组件计算（`buildItems`），本组件只负责定位、键盘导航与渲染。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface MenuItem {
  /** 分隔线用 `separator`。 */
  key: string;
  label?: string;
  /** 快捷键提示（右对齐展示，不绑定按键）。 */
  hint?: string;
  disabled?: boolean;
  separator?: boolean;
  danger?: boolean;
  onSelect?: () => void;
}

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

export default function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  const [active, setActive] = useState(-1);

  const selectable = items.map((item, index) => ({ item, index })).filter(({ item }) => !item.separator && !item.disabled);

  /** 贴边时把菜单移回视口内（避免被裁掉）。 */
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const maxLeft = window.innerWidth - rect.width - 8;
    const maxTop = window.innerHeight - rect.height - 8;
    setPosition({ left: Math.max(8, Math.min(x, maxLeft)), top: Math.max(8, Math.min(y, maxTop)) });
  }, [x, y, items.length]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        const currentIndex = selectable.findIndex(({ index }) => index === active);
        const next = Math.max(0, Math.min(selectable.length - 1, (currentIndex < 0 ? -1 : currentIndex) + step));
        setActive(selectable[next]?.index ?? -1);
        return;
      }
      if (e.key === "Enter" && active >= 0) {
        e.preventDefault();
        const item = items[active];
        if (item && !item.disabled && item.onSelect) {
          item.onSelect();
          onClose();
        }
      }
    };
    const onScroll = () => onClose();
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll, true);
    };
  }, [active, items, onClose, selectable]);

  return (
    <div className="context-menu" ref={ref} style={{ left: position.left, top: position.top }} role="menu">
      {items.map((item, index) =>
        item.separator ? (
          <div className="menu-sep" key={item.key} />
        ) : (
          <button
            key={item.key}
            role="menuitem"
            className={`menu-item${index === active ? " active" : ""}${item.danger ? " danger" : ""}`}
            disabled={item.disabled}
            onMouseEnter={() => setActive(index)}
            onClick={() => {
              if (item.disabled) return;
              item.onSelect?.();
              onClose();
              // 焦点交还网格：菜单按钮马上会被卸载，否则 activeElement 落回 body，
              // 用户接着按 Ctrl+Z / 方向键都不会被网格接收到
              requestAnimationFrame(() => {
                document.querySelector<HTMLElement>(".grid-shell")?.focus();
              });
            }}
          >
            <span className="menu-label">{item.label}</span>
            {item.hint && <span className="menu-hint">{item.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}
