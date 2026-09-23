"use client";

import { AutomationDetails, EnvironmentTabs, type AutomationView } from "./automation-center";
import type { Props } from "./automation-mobile";

export type AutomationStatus = { shadowActive: boolean; testnetOperating: boolean; testnetError: boolean; testnetAttention?: boolean };

export function AutomationStatusStrip({ status }: { status: AutomationStatus }) {
  return <div className="cp-status-strip" aria-label="Estado dos ambientes">
    <span className={status.shadowActive ? "cp-green" : "cp-muted"}><i />SHADOW {status.shadowActive ? "ATIVO" : "PAUSADO"}</span>
    <span className={status.testnetError ? "cp-red" : status.testnetAttention ? "cp-attention" : status.testnetOperating ? "cp-green" : "cp-purple"}><i />TESTNET {status.testnetError ? "DIVERGÊNCIA ATIVA" : status.testnetAttention ? "ATENÇÃO" : status.testnetOperating ? "MOTOR OK" : "EM ESPERA"}</span>
    <span className="cp-muted"><i />LIVE BLOQUEADO</span>
  </div>;
}

export function AutomationCenter({ view, data }: { view: AutomationView; data: Props }) {
  return <div className="coinops-automation ac-cockpit ac-dense" data-view={view}>
    <EnvironmentTabs view={view} />
    <AutomationDetails view={view} data={data} section="all" asset="SOL" />
  </div>;
}
