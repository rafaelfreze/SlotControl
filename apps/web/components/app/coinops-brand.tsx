import Image from "next/image";

type CoinOpsBrandProps = {
  compact?: boolean;
  subtitle?: string;
};

export function CoinOpsBrand({ compact = false, subtitle = "Operacoes inteligentes em cripto" }: CoinOpsBrandProps) {
  return (
    <span className={`coinops-brand${compact ? " compact" : ""}`}>
      <Image className="coinops-brand-symbol" src="/icon-192x192.png" alt="" width={compact ? 34 : 48} height={compact ? 34 : 48} priority />
      <span className="coinops-brand-copy">
        <strong>CoinOps</strong>
        {compact ? null : <small>{subtitle}</small>}
      </span>
    </span>
  );
}
