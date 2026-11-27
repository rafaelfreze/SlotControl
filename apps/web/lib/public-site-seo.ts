import type { Metadata, MetadataRoute } from "next";

/** Official institutional origin; request hosts, account IDs and query strings never enter SEO. */
export const PUBLIC_SITE_ORIGIN = "https://cripto-flax.vercel.app";
export const publicHomeMetadata: Metadata = {
  alternates: { canonical: `${PUBLIC_SITE_ORIGIN}/` },
  robots: { index: true, follow: true },
  openGraph: {
    title: "CoinOps", description: "Operacoes inteligentes em criptomoedas",
    siteName: "CoinOps", type: "website", url: `${PUBLIC_SITE_ORIGIN}/`,
  },
};

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
