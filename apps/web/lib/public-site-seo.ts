import type { Metadata, MetadataRoute } from "next";

/** Official institutional origin; request hosts, account IDs and query strings never enter SEO. */
export const PUBLIC_SITE_ORIGIN = "https://cripto-flax.vercel.app";
export const PUBLIC_SITE_NAME = "CoinOps";
export const PUBLIC_SITE_TITLE = "CoinOps | Acompanhamento de operações em criptomoedas";
export const PUBLIC_SITE_DESCRIPTION = "Acompanhe suas operações em criptomoedas com painel protegido e dados separados por conta. O acesso operacional depende de configuração e autorização.";
export const PUBLIC_SHARE_IMAGE = `${PUBLIC_SITE_ORIGIN}/icon-512x512.png`;
export const publicHomeMetadata: Metadata = {
  title: { absolute: PUBLIC_SITE_TITLE },
  description: PUBLIC_SITE_DESCRIPTION,
  alternates: { canonical: `${PUBLIC_SITE_ORIGIN}/` },
  robots: { index: true, follow: true },
  openGraph: {
    title: PUBLIC_SITE_TITLE, description: PUBLIC_SITE_DESCRIPTION,
    siteName: PUBLIC_SITE_NAME, type: "website", url: `${PUBLIC_SITE_ORIGIN}/`,
    images: [{ url: PUBLIC_SHARE_IMAGE, width: 512, height: 512, type: "image/png", alt: PUBLIC_SITE_NAME }],
  },
  twitter: { card: "summary", title: PUBLIC_SITE_TITLE, description: PUBLIC_SITE_DESCRIPTION, images: [PUBLIC_SHARE_IMAGE] },
};

/** Anonymous institutional identity only. No account, performance or financial claims. */
export const publicHomeStructuredData = {
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "WebSite", "@id": `${PUBLIC_SITE_ORIGIN}/#website`, url: `${PUBLIC_SITE_ORIGIN}/`, name: PUBLIC_SITE_NAME,
      description: PUBLIC_SITE_DESCRIPTION, inLanguage: "pt-BR", image: PUBLIC_SHARE_IMAGE },
    { "@type": "WebPage", "@id": `${PUBLIC_SITE_ORIGIN}/#webpage`, url: `${PUBLIC_SITE_ORIGIN}/`, name: PUBLIC_SITE_TITLE,
      description: PUBLIC_SITE_DESCRIPTION, inLanguage: "pt-BR", isPartOf: { "@id": `${PUBLIC_SITE_ORIGIN}/#website` }, mainEntity: { "@id": `${PUBLIC_SITE_ORIGIN}/#software` } },
    { "@type": "SoftwareApplication", "@id": `${PUBLIC_SITE_ORIGIN}/#software`, url: `${PUBLIC_SITE_ORIGIN}/`, name: PUBLIC_SITE_NAME,
      description: PUBLIC_SITE_DESCRIPTION, applicationCategory: "FinanceApplication", operatingSystem: "Web",
      featureList: ["Painel protegido", "Acompanhamento de operações em criptomoedas", "Dados separados por conta"],
      mainEntityOfPage: { "@id": `${PUBLIC_SITE_ORIGIN}/#webpage` } },
  ],
} as const;
export const publicHomeJsonLd = JSON.stringify(publicHomeStructuredData).replaceAll("<", "\\u003c");

export function publicRobots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: [
      "/api/", "/auth/", "/login", "/cadastro", "/recuperar-senha", "/redefinir-senha",
      "/acesso-suspenso", "/alertas", "/assinatura", "/automacao", "/ciclos", "/config",
      "/custos-operacao", "/dashboard", "/historico", "/mais", "/meu-coinops", "/plano-crescimento",
      "/primeiros-passos", "/relatorios", "/slots",
    ] },
    sitemap: `${PUBLIC_SITE_ORIGIN}/sitemap.xml`,
  };
}

export function publicSitemap(): MetadataRoute.Sitemap {
  // Private application screens, individual accounts and auth routes are never listed.
  return [{ url: `${PUBLIC_SITE_ORIGIN}/`, changeFrequency: "monthly", priority: 1 }];
}
