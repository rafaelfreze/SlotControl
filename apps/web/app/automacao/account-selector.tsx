"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { accountStateLabel, searchAccountOptions, type AccountOption } from "./account-selector-model";

const PAGE_SIZE = 40;

export function AccountSelector({ options, value, onChange, allLabel = "Todos", includeAll = true,
  label = "Conta" }: { options: AccountOption[]; value: string; onChange: (id: string) => void;
  allLabel?: string; includeAll?: boolean; label?: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const selected = options.find((option) => option.id === value);
  const filtered = useMemo(() => searchAccountOptions(options, query), [options, query]);
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const choose = (id: string) => { onChange(id); setOpen(false); setQuery(""); setLimit(PAGE_SIZE); };
  return <div className="px-account-selector" ref={root}>
    <span className="px-account-selector-label">{label}</span>
    <button type="button" className="px-account-selector-trigger" aria-label={label}
      aria-expanded={open} aria-haspopup="listbox" onClick={() => setOpen((current) => !current)}>
      {selected ? <span className={`px-account-option px-account-state-${selected.state.toLowerCase()}`}>
        <span className="px-account-dot" aria-hidden="true" />{selected.displayName}<small>{accountStateLabel[selected.state]}</small>
      </span> : allLabel}<span aria-hidden="true">⌄</span>
    </button>
    {open ? <div className="px-account-selector-popover" onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); setOpen(false); }
    }}>
      <input ref={input} type="search" aria-label="Pesquisar conta por nome, identificador ou mercado"
        placeholder="Pesquisar conta..." value={query} onChange={(event) => { setQuery(event.target.value); setLimit(PAGE_SIZE); }} />
      <div className="px-account-selector-results" role="listbox" aria-label="Contas encontradas">
        {includeAll && !query ? <button type="button" role="option" aria-selected={value === "ALL"}
          onClick={() => choose("ALL")}>{allLabel}</button> : null}
        {filtered.slice(0, limit).map((option) => <button type="button" role="option" key={option.id}
          aria-selected={value === option.id} onClick={() => choose(option.id)}>
          <span className={`px-account-option px-account-state-${option.state.toLowerCase()}`}>
            <span className="px-account-dot" aria-hidden="true" /><span>{option.displayName}<small>{accountStateLabel[option.state]} · {option.markets.join(", ") || "Sem motor"}</small></span>
          </span>
        </button>)}
        {!filtered.length ? <p>Nenhuma conta encontrada.</p> : null}
        {filtered.length > limit ? <button type="button" className="px-account-more" onClick={() => setLimit((current) => current + PAGE_SIZE)}>
          Mostrar mais ({filtered.length - limit} restantes)</button> : null}
      </div>
    </div> : null}
  </div>;
}
