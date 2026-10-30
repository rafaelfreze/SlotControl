"use client";
"use client";
import { a as metricNames, c as summarizePaid, n as channelNames, o as productNames, r as comparison, s as stages, t as businessMetrics } from "./shared-BDbViiFo.mjs";
import { useId, useState } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
//#region node_modules/@onplay/marketing-premium/dist/dashboard.js
const colors = [
	"#1685ff",
	"#03c77d",
	"#9946f7",
	"#ff7c16",
	"#fa205e",
	"#ffbb29"
];
const money = (v, currency = "BRL") => v === null ? "Indisponível" : new Intl.NumberFormat("pt-BR", {
	style: "currency",
	currency
}).format(v);
const number = (v) => v === null ? "Indisponível" : v.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
const date = (v) => v.split("-").reverse().join("/");
const paths = {
	home: "M3 10 12 3l9 7v11h-6v-7H9v7H3Z",
	ads: "M3 8h4l12-5v18L7 16H3Zm4 8 2 6h4l-2-5",
	site: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z",
	contacts: "M21 15a3 3 0 0 1-3 3H8l-5 4V5a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3ZM7 8h10M7 12h7",
	sales: "M4 8h16v13H4ZM8 8V6a4 4 0 0 1 8 0v2M9 14h6",
	report: "M5 2h10l4 4v16H5ZM9 10h6M9 14h6M9 18h4",
	settings: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2",
	users: "M16 21v-3a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v3M13 5a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm8 16v-3a4 4 0 0 0-3-4m-1-13a4 4 0 0 1 0 8",
	calendar: "M4 5h16v17H4ZM8 2v6m8-6v6M4 11h16m-11 4h2m2 0h2",
	download: "M12 3v12m-5-5 5 5 5-5M4 17v5h16v-5",
	share: "m9 7 8-4m-8 14 8 4M7 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm13-5a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm0 16a3 3 0 1 0 0 6 3 3 0 0 0 0-6",
	menu: "M3 6h18M3 12h18M3 18h18",
	arrow: "m9 5 7 7-7 7",
	check: "m4 12 5 5L20 6"
};
function Icon({ name, size = 21 }) {
	return jsx("svg", {
		width: size,
		height: size,
		viewBox: "0 0 24 24",
		fill: "none",
		stroke: "currentColor",
		strokeWidth: "1.7",
		strokeLinecap: "round",
		strokeLinejoin: "round",
		"aria-hidden": "true",
		children: jsx("path", { d: paths[name] ?? paths.report })
	});
}
function Brand() {
	return jsxs("span", {
		className: "opm-brand",
		children: [jsx("img", {
			src: "/brand/onplay-official-symbol.png",
			width: "34",
			height: "34",
			alt: ""
		}), jsxs("span", { children: [jsx("img", {
			className: "opm-wordmark",
			src: "/brand/onplay-official-wordmark.png",
			width: "130",
			height: "33",
			alt: "OnPlay"
		}), jsx("small", { children: "MARKETING & SISTEMAS" })] })]
	});
}
function segments(values) {
	const parts = [];
	values.forEach((v, i) => {
		if (v === null) return;
		if (i === 0 || values[i - 1] === null) parts.push([]);
		parts.at(-1).push([i, v]);
	});
	return parts;
}
function Trend({ data }) {
	const uid = useId().replace(/:/g, "");
	const points = data.points ?? data.trend.map((p) => ({
		...p,
		intents: null,
		conversations: null
	}));
	const any = points.some((p) => p.visits !== null || p.intents !== null || p.conversations !== null);
	const max = Math.max(4, ...points.flatMap((p) => [
		p.visits ?? 0,
		p.intents ?? 0,
		p.conversations ?? 0
	]));
	const x = (i) => 48 + (points.length === 1 ? 0 : i / (points.length - 1) * 610), y = (v) => 210 - v / max * 170;
	return jsxs("section", {
		className: "opm-panel opm-trend",
		id: "site",
		children: [
			jsxs("div", {
				className: "opm-panel-head",
				children: [jsxs("div", { children: [jsx("h2", { children: "Evolução de visitas e contatos" }), jsx("p", { children: "O movimento do seu site, dia a dia" })] }), jsx("span", {
					className: "opm-pill",
					children: "Por dia"
				})]
			}),
			jsx("div", {
				className: "opm-legend",
				children: [
					"Visualizações",
					"Intenções de contato",
					"Conversas"
				].map((l, i) => jsxs("span", { children: [jsx("i", { style: { background: colors[i] } }), l] }, l))
			}),
			any ? jsxs("svg", {
				viewBox: "0 0 690 255",
				className: "opm-chart",
				role: "img",
				"aria-label": `Evolução diária de ${date(data.period.from)} a ${date(data.period.to)}; detalhes na tabela de dados.`,
				children: [
					jsx("defs", { children: jsxs("linearGradient", {
						id: uid,
						x1: "0",
						y1: "0",
						x2: "0",
						y2: "1",
						children: [jsx("stop", {
							stopColor: colors[0],
							stopOpacity: ".26"
						}), jsx("stop", {
							offset: "1",
							stopColor: colors[0],
							stopOpacity: "0"
						})]
					}) }),
					[
						0,
						.25,
						.5,
						.75,
						1
					].map((t) => jsxs("g", { children: [jsx("line", {
						x1: "48",
						x2: "660",
						y1: y(max * t),
						y2: y(max * t),
						stroke: "#213242",
						strokeWidth: ".7"
					}), jsx("text", {
						x: "38",
						y: y(max * t) + 4,
						textAnchor: "end",
						fill: "#a2b6c6",
						fontSize: "11",
						children: Math.round(max * t)
					})] }, t)),
					[
						"visits",
						"intents",
						"conversations"
					].map((key, k) => segments(points.map((p) => p[key])).map((part, i) => jsxs("g", { children: [
						k === 0 && part.length > 1 ? jsx("path", {
							d: `M${x(part[0][0])},210 ${part.map(([n, v]) => `L${x(n)},${y(v)}`).join(" ")} L${x(part.at(-1)[0])},210 Z`,
							fill: `url(#${uid})`
						}) : null,
						jsx("polyline", {
							points: part.map(([n, v]) => `${x(n)},${y(v)}`).join(" "),
							stroke: colors[k],
							fill: "none",
							strokeWidth: "2.2"
						}),
						part.filter((_, j) => points.length < 40 || j % 3 === 0).map(([n, v]) => jsx("circle", {
							cx: x(n),
							cy: y(v),
							r: "3",
							fill: colors[k],
							children: jsx("title", { children: `${date(points[n].date)} · ${key === "visits" ? "Visualizações" : key === "intents" ? "Intenções" : "Conversas"}: ${v}` })
						}, n))
					] }, `${key}:${i}`))),
					[.../* @__PURE__ */ new Set([
						0,
						Math.floor((points.length - 1) / 2),
						points.length - 1
					])].map((i) => jsx("text", {
						x: x(i),
						y: "241",
						textAnchor: i === 0 ? "start" : i === points.length - 1 ? "end" : "middle",
						fontSize: "11",
						fill: "#b1c2ce",
						children: date(points[i].date).slice(0, 5)
					}, i))
				]
			}) : jsx(Empty, {
				icon: "site",
				title: "Aguardando dados do site",
				text: "Os dias sem cobertura ficam em branco, sem estimar visitas."
			}),
			jsxs("details", {
				className: "opm-detail",
				children: [jsx("summary", { children: "Consultar valores por dia" }), jsx("div", {
					className: "opm-table-wrap",
					children: jsxs("table", { children: [jsx("thead", { children: jsxs("tr", { children: [
						jsx("th", { children: "Data" }),
						jsx("th", { children: "Visualizações" }),
						jsx("th", { children: "Intenções" }),
						jsx("th", { children: "Conversas" })
					] }) }), jsx("tbody", { children: points.map((p) => jsxs("tr", { children: [
						jsx("td", { children: date(p.date) }),
						jsx("td", { children: number(p.visits) }),
						jsx("td", { children: number(p.intents) }),
						jsx("td", { children: number(p.conversations) })
					] }, p.date)) })] })
				})]
			})
		]
	});
}
function Empty({ icon, title, text }) {
	return jsxs("div", {
		className: "opm-empty",
		children: [
			jsx("span", { children: jsx(Icon, {
				name: icon,
				size: 28
			}) }),
			jsx("strong", { children: title }),
			jsx("p", { children: text })
		]
	});
}
function MarketingDashboard({ data, product, companyKey, basePath, previous, paid, title = "Visão geral", eyebrow, query, details, filters, master = false, sources, canExport = true, reportEditor, backHref }) {
	const [menu, setMenu] = useState(false), [busy, setBusy] = useState(false), [status, setStatus] = useState("");
	const ads = summarizePaid(data.currency === "BRL" ? paid : void 0, data.period.from, data.period.to, data.channel);
	const get = (key) => data.metrics.find((m) => m.key === key)?.value ?? null;
	const saleKey = get("purchases") !== null ? "purchases" : "closures";
	const cards = [
		{
			key: "visits",
			label: metricNames.visits,
			icon: "users",
			value: get("visits")
		},
		{
			key: "intents",
			label: metricNames.intents,
			icon: "contacts",
			value: get("intents")
		},
		{
			key: "conversations",
			label: metricNames.conversations,
			icon: "contacts",
			value: get("conversations")
		},
		{
			key: "appointments",
			label: metricNames.appointments,
			icon: "calendar",
			value: get("appointments")
		},
		{
			key: saleKey,
			label: metricNames[saleKey],
			icon: "sales",
			value: get(saleKey)
		},
		{
			key: "spend",
			label: "Investimento em anúncios",
			icon: "ads",
			value: ads.spend
		}
	];
	const steps = stages(data, product);
	const channelRows = data.channels.filter((c) => c.visits !== null && c.visits > 0);
	const total = channelRows.reduce((s, c) => s + c.visits, 0), whole = get("visits");
	const exact = whole !== null && total === whole && total > 0;
	const originColors = [
		"#1685ff",
		"#a044f7",
		"#03c77d",
		"#ffbb29",
		"#f52b67"
	];
	const stops = channelRows.map((c, i) => {
		const start = total ? channelRows.slice(0, i).reduce((s, row) => s + row.visits, 0) / total * 100 : 0;
		const end = start + (total ? c.visits / total * 100 : 0);
		return `${originColors[i % 5]} ${start}% ${end}%`;
	}).join(",");
	const nav = [
		[
			"home",
			"Visão geral",
			"overview"
		],
		[
			"ads",
			"Tráfego pago",
			"trafego"
		],
		[
			"site",
			"Site e visitantes",
			"site"
		],
		[
			"contacts",
			"Leads e contatos",
			"resultados"
		],
		[
			"sales",
			"Vendas e orçamentos",
			"resultados"
		],
		[
			"report",
			"Relatórios",
			"relatorios"
		],
		[
			"settings",
			"Configurações",
			"configuracao"
		]
	];
	async function exportPdf(share) {
		setBusy(true);
		setStatus("");
		try {
			const { createReportPdf } = await import("./shared-DId2t5cX.mjs");
			const bytes = await createReportPdf({
				data,
				product,
				companyKey,
				previous,
				paid
			});
			const file = new File([new Uint8Array(bytes)], `onplay-${data.clientName.replace(/[^a-zA-Z0-9À-ÿ-]/g, "-")}-${data.period.from}-${data.period.to}.pdf`, { type: "application/pdf" });
			if (share && navigator.canShare?.({ files: [file] })) {
				await navigator.share({
					files: [file],
					title: `Marketing · ${data.clientName}`
				});
				setStatus("Relatório compartilhado.");
			} else {
				const url = URL.createObjectURL(file);
				const a = document.createElement("a");
				a.href = url;
				a.download = file.name;
				a.click();
				setTimeout(() => URL.revokeObjectURL(url), 3e4);
				setStatus("PDF gerado. Use o arquivo para compartilhar.");
			}
		} catch (e) {
			setStatus(e instanceof DOMException && e.name === "AbortError" ? "Compartilhamento cancelado." : "Não foi possível gerar o PDF. Tente novamente.");
		} finally {
			setBusy(false);
		}
	}
	return jsxs("div", {
		className: `opm-root ${master ? "opm-master" : "opm-embedded"}`,
		"data-marketing-premium": true,
		children: [master ? jsxs("aside", {
			className: `opm-sidebar ${menu ? "opm-menu-open" : ""}`,
			children: [
				jsx("a", {
					className: "opm-logo-link",
					href: basePath,
					"aria-label": "Central de Marketing OnPlay",
					children: jsx(Brand, {})
				}),
				jsx("nav", {
					"aria-label": "Marketing",
					children: nav.map(([icon, label, id], i) => jsxs("a", {
						href: `#${id}`,
						onClick: () => setMenu(false),
						className: i === 0 ? "opm-active" : "",
						children: [jsx(Icon, { name: icon }), label]
					}, label))
				}),
				jsxs("div", {
					className: "opm-products",
					children: [
						jsx("small", { children: "Empresas conectadas" }),
						Object.entries(productNames).map(([key, label], i) => jsxs("a", {
							href: `${basePath}?product=${key}#empresa`,
							onClick: () => setMenu(false),
							children: [jsx("i", {
								style: { background: colors[i] },
								children: label.slice(0, 1)
							}), label]
						}, key)),
						jsxs("a", {
							href: backHref ?? "/master",
							children: [jsx(Icon, { name: "arrow" }), "Voltar ao Master"]
						})
					]
				})
			]
		}) : null, jsxs("div", {
			className: "opm-workspace",
			children: [
				jsxs("header", {
					className: "opm-topbar",
					children: [
						jsxs("div", {
							className: "opm-mobile-brand",
							children: [jsx("button", {
								type: "button",
								className: "opm-icon-button",
								"aria-label": "Abrir navegação de marketing",
								"aria-expanded": menu,
								onClick: () => setMenu(!menu),
								children: jsx(Icon, { name: "menu" })
							}), jsx(Brand, {})]
						}),
						jsxs("div", {
							className: "opm-top-identity",
							children: [jsx(Icon, { name: "users" }), jsxs("span", { children: [jsx("strong", { children: data.clientName }), jsx("small", { children: productNames[product] })] })]
						}),
						jsxs("div", {
							className: "opm-top-period",
							children: [jsx(Icon, { name: "calendar" }), jsxs("span", { children: [jsx("strong", { children: data.period.label }), jsxs("small", { children: [
								date(data.period.from),
								" - ",
								date(data.period.to)
							] })] })]
						}),
						canExport ? jsxs("div", {
							className: "opm-actions",
							children: [jsxs("button", {
								type: "button",
								disabled: busy,
								onClick: () => exportPdf(true),
								children: [jsx(Icon, { name: "share" }), jsx("span", { children: busy ? "Gerando…" : "Compartilhar relatório" })]
							}), jsx("button", {
								type: "button",
								className: "opm-icon-button",
								disabled: busy,
								"aria-label": "Baixar relatório PDF",
								onClick: () => exportPdf(false),
								children: jsx(Icon, { name: "download" })
							})]
						}) : null,
						jsx("span", {
							className: "opm-avatar",
							title: master ? "Acesso Master" : "Sua empresa",
							children: master ? "M" : data.clientName.slice(0, 1)
						})
					]
				}),
				jsxs("main", {
					className: "opm-main",
					id: "overview",
					children: [
						jsxs("div", {
							className: "opm-heading",
							children: [jsxs("div", { children: [
								jsx("span", {
									className: "opm-eyebrow",
									children: eyebrow ?? "ONPLAY · INTELIGÊNCIA DE MARKETING"
								}),
								jsx("h1", { children: title }),
								jsx("p", { children: "Resultados do site e da sua empresa em um só lugar." })
							] }), jsxs("span", {
								className: `opm-live ${data.quality === "disconnected" ? "opm-offline" : ""}`,
								children: [jsx("i", {}), data.quality === "disconnected" ? "Fonte indisponível" : data.quality === "empty" ? "Aguardando seleção ou dados" : data.quality === "partial" ? "Dados observados · parciais" : "Dados atualizados"]
							})]
						}),
						jsx("div", {
							id: "empresa",
							className: "opm-filter-box",
							children: filters ?? jsxs("form", {
								action: basePath,
								method: "get",
								className: "opm-filters",
								children: [
									Object.entries(query ?? {}).map(([key, v]) => jsx("input", {
										type: "hidden",
										name: key,
										value: v
									}, key)),
									jsxs("label", { children: ["Período", jsxs("select", {
										name: "period",
										defaultValue: data.period.key,
										children: [
											jsx("option", {
												value: "today",
												children: "Hoje"
											}),
											jsx("option", {
												value: "7d",
												children: "Últimos 7 dias"
											}),
											jsx("option", {
												value: "30d",
												children: "Últimos 30 dias"
											}),
											jsx("option", {
												value: "custom",
												children: "Personalizado"
											})
										]
									})] }),
									jsxs("label", { children: ["Origem", jsx("select", {
										name: "channel",
										defaultValue: data.channel,
										children: Object.entries(channelNames).map(([v, l]) => jsx("option", {
											value: v,
											children: l
										}, v))
									})] }),
									jsxs("label", { children: ["De", jsx("input", {
										name: "from",
										type: "date",
										defaultValue: data.period.from
									})] }),
									jsxs("label", { children: ["Até", jsx("input", {
										name: "to",
										type: "date",
										defaultValue: data.period.to
									})] }),
									jsx("button", {
										type: "submit",
										className: "opm-primary",
										children: "Ver resultados"
									})
								]
							})
						}),
						status ? jsx("p", {
							role: "status",
							className: "opm-status",
							children: status
						}) : null,
						data.period.warning ? jsx("p", {
							role: "status",
							className: "opm-status",
							children: data.period.warning
						}) : null,
						jsx("div", {
							className: "opm-kpis",
							children: cards.map((c, i) => {
								const change = comparison(data, previous, c.key), partial = c.key === "spend" ? !ads.complete : data.partialMetrics?.includes(c.key) ?? data.quality === "partial";
								return jsxs("article", {
									className: `opm-kpi opm-tone-${i}`,
									children: [jsx("span", {
										className: "opm-kpi-icon",
										children: jsx(Icon, {
											name: c.icon,
											size: 25
										})
									}), jsxs("div", { children: [
										jsx("h2", { children: c.label }),
										jsx("strong", {
											className: c.value === null ? "opm-unavailable" : "",
											children: c.key === "spend" ? money(c.value, data.currency) : number(c.value)
										}),
										jsx("div", {
											className: "opm-kpi-meta",
											children: change !== null ? jsxs(Fragment, { children: [jsxs("span", {
												className: `opm-delta ${change < 0 ? "opm-down" : ""}`,
												children: [
													change >= 0 ? "↑" : "↓",
													" ",
													Math.abs(change).toLocaleString("pt-BR", { maximumFractionDigits: 1 }),
													"%"
												]
											}), jsx("small", { children: "vs. período anterior" })] }) : jsx("small", { children: c.value === null ? "Sem cobertura confiável" : partial ? "Parcial · ações observadas" : "Período medido" })
										})
									] })]
								}, c.key);
							})
						}),
						jsxs("div", {
							className: "opm-main-grid",
							children: [jsxs("section", {
								className: "opm-panel opm-funnel",
								children: [
									jsx("div", {
										className: "opm-panel-head",
										children: jsxs("div", { children: [jsx("h2", { children: "Funil de resultados" }), jsx("p", { children: "Do site ao resultado comercial" })] })
									}),
									jsx("div", {
										className: "opm-funnel-stages",
										children: steps.map((s, i) => jsxs("div", {
											className: "opm-stage",
											style: {
												width: `${100 - i * 9}%`,
												background: colors[i % colors.length]
											},
											children: [jsx("strong", { children: number(s.value) }), jsx("span", { children: s.label })]
										}, s.key))
									}),
									jsx("p", {
										className: "opm-caption",
										children: "Etapas independentes. Taxas ficam indisponíveis quando as populações são diferentes."
									})
								]
							}), jsx(Trend, { data })]
						}),
						jsxs("div", {
							className: "opm-secondary-grid",
							children: [
								jsxs("section", {
									className: "opm-panel",
									children: [jsx("h2", { children: "Origem das visualizações" }), total > 0 ? jsxs(Fragment, { children: [jsxs("div", {
										className: "opm-origins",
										children: [jsx("div", {
											className: "opm-donut",
											style: { background: `conic-gradient(${stops})` },
											role: "img",
											"aria-label": `Distribuição de ${number(total)} visualizações com origem registrada`,
											children: jsxs("div", { children: [jsx("strong", { children: number(total) }), jsx("small", { children: exact ? "visualizações" : "com origem" })] })
										}), jsx("ul", {
											className: "opm-origin-list",
											children: channelRows.map((c, i) => jsxs("li", { children: [
												jsx("i", { style: { background: originColors[i % 5] } }),
												jsx("span", { children: channelNames[c.key] }),
												exact ? jsxs("b", { children: [(c.visits / total * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 }), "%"] }) : null,
												jsx("strong", { children: number(c.visits) })
											] }, c.key))
										})]
									}), !exact ? jsx("p", {
										className: "opm-caption",
										children: "Distribuição parcial. Não representa todas as visualizações."
									}) : null] }) : jsx(Empty, {
										icon: "site",
										title: "Origem indisponível",
										text: "Atribuição aparece quando registrada pela fonte. A recusa de rastreamento é respeitada."
									})]
								}),
								jsxs("section", {
									className: "opm-panel",
									id: "trafego",
									children: [
										jsx("h2", { children: "Investimento em anúncios" }),
										["google_ads", "meta"].map((p, i) => {
											const r = ads.rows.filter((r) => r.platform === p);
											const legacy = ads.legacy.filter((r) => r.platform === p);
											const value = r.length ? r.reduce((s, r) => s + r.spendCents, 0) / 100 : legacy.length ? legacy.reduce((s, r) => s + r.spendCents, 0) / 100 : null;
											return jsxs("div", {
												className: "opm-investment",
												children: [jsx("span", {
													className: `opm-provider opm-provider-${i}`,
													children: i === 0 ? "G" : "∞"
												}), jsxs("div", { children: [jsx("small", { children: channelNames[p] }), jsx("strong", { children: money(value, data.currency) })] })]
											}, p);
										}),
										jsxs("div", {
											className: "opm-total",
											children: [jsxs("small", { children: ["Investimento ", ads.complete ? "registrado" : "observado"] }), jsx("strong", { children: money(ads.spend, data.currency) })]
										}),
										jsx("p", {
											className: "opm-caption",
											children: paid?.available ? ads.legacy.length ? "Custos da conta já comprovados no FinOps. Sem somar com os relatórios por campanha." : ads.rows.length ? "Relatórios publicados pela OnPlay. Conversões publicitárias não são somadas aos contatos do site." : "Nenhum relatório publicado neste período." : "Fonte de mídia indisponível. Nenhum gasto foi estimado."
										})
									]
								}),
								jsxs("section", {
									className: "opm-panel",
									children: [jsx("h2", { children: "Páginas mais acessadas" }), data.pages?.length ? jsx("ol", {
										className: "opm-pages",
										children: data.pages.slice().sort((a, b) => b.views - a.views).slice(0, 6).map((p) => jsxs("li", { children: [jsx("span", {
											title: p.path,
											children: p.path
										}), jsx("strong", { children: number(p.views) })] }, p.path))
									}) : jsx(Empty, {
										icon: "report",
										title: "Ranking indisponível",
										text: "Exibido apenas quando a fonte informa páginas e cobertura do período."
									})]
								})
							]
						}),
						jsxs("section", {
							className: "opm-panel",
							id: "medicao",
							children: [
								jsx("h2", { children: "Cliques e cobertura da medição" }),
								jsx("p", { children: "Contagem operacional separada da publicidade e das conversas recebidas." }),
								jsx("div", {
									className: "opm-results",
									children: [
										"operational_whatsapp",
										"operational_phone",
										"authorized_intents",
										"meta_contacts"
									].map((key) => {
										const m = data.metrics.find((m) => m.key === key);
										return jsxs("div", { children: [
											jsx("span", { children: m?.label ?? {
												operational_whatsapp: "Cliques WhatsApp agregados",
												operational_phone: "Cliques em telefone",
												authorized_intents: "Intenções com medição autorizada",
												meta_contacts: "Contact recebidos pelo Meta"
											}[key] }),
											jsx("strong", { children: number(m?.value ?? null) }),
											jsx("small", { children: m?.note ?? "Fonte específica não integrada; indisponível não significa zero." })
										] }, key);
									})
								}),
								jsx("p", {
									className: "opm-caption",
									children: "Não some cliques agregados e autorizados: as populações podem se sobrepor. Contact recebido pelo Meta exige confirmação do provedor; disparar uma tag não comprova recepção. Um clique não confirma conversa, qualificação ou venda."
								}),
								data.measurementPoints?.some((p) => p.whatsapp !== null) ? jsxs(Fragment, { children: [jsx("svg", {
									viewBox: "0 0 690 130",
									className: "opm-chart",
									role: "img",
									"aria-label": "Cliques WhatsApp agregados por dia",
									children: segments(data.measurementPoints.map((p) => p.whatsapp)).map((part, index) => jsxs("g", { children: [jsx("polyline", {
										fill: "none",
										stroke: "#03c77d",
										strokeWidth: "2.5",
										points: part.map(([i, v]) => `${24 + i / Math.max(1, data.measurementPoints.length - 1) * 640},${110 - v / Math.max(1, ...data.measurementPoints.map((q) => q.whatsapp ?? 0)) * 90}`).join(" ")
									}), part.map(([i, v]) => jsx("circle", {
										cx: 24 + i / Math.max(1, data.measurementPoints.length - 1) * 640,
										cy: 110 - v / Math.max(1, ...data.measurementPoints.map((q) => q.whatsapp ?? 0)) * 90,
										r: "3",
										fill: "#03c77d",
										children: jsxs("title", { children: [
											date(data.measurementPoints[i].date),
											": ",
											v
										] })
									}, i))] }, index))
								}), jsxs("details", { children: [jsxs("summary", { children: [
									"Cliques por dia · ",
									date(data.period.from),
									" a ",
									date(data.period.to)
								] }), jsx("div", {
									className: "opm-table-wrap",
									children: jsxs("table", { children: [jsx("thead", { children: jsxs("tr", { children: [
										jsx("th", { children: "Dia" }),
										jsx("th", { children: "WhatsApp" }),
										jsx("th", { children: "Telefone" })
									] }) }), jsx("tbody", { children: data.measurementPoints.map((p) => jsxs("tr", { children: [
										jsx("td", { children: date(p.date) }),
										jsx("td", { children: number(p.whatsapp) }),
										jsx("td", { children: number(p.phone) })
									] }, p.date)) })] })
								})] })] }) : null
							]
						}),
						jsxs("section", {
							className: "opm-panel",
							id: "resultados",
							children: [
								jsxs("div", {
									className: "opm-panel-head",
									children: [jsxs("div", { children: [jsx("h2", { children: "Resultados comerciais" }), jsx("p", { children: "Registros da operação, separados das métricas de anúncios" })] }), jsxs("span", {
										className: "opm-pill",
										children: [
											date(data.period.from),
											" - ",
											date(data.period.to)
										]
									})]
								}),
								jsx("div", {
									className: "opm-results",
									children: businessMetrics(data).map((m) => jsxs("div", {
										title: m.note,
										children: [
											jsx("span", { children: m.label }),
											jsx("strong", { children: number(m.value) }),
											jsx("small", { children: m.value === null ? "Indisponível" : m.note?.startsWith("Cobertura parcial") ? "Registro parcial" : "Registrado no sistema" })
										]
									}, m.key))
								}),
								jsx("p", {
									className: "opm-caption",
									children: "Agendamentos criados e atendimentos realizados são etapas diferentes. Sem origem comprovada, os registros comerciais não são atribuídos ao Google ou Meta nem usados para calcular custo por cliente."
								})
							]
						}),
						jsxs("section", {
							className: "opm-panel",
							id: "relatorios",
							children: [
								jsxs("div", {
									className: "opm-panel-head",
									children: [jsxs("div", { children: [jsx("h2", { children: "Relatórios de tráfego pago" }), jsx("p", { children: "Campanhas e períodos publicados pela OnPlay" })] }), jsx("span", {
										className: "opm-pill",
										children: "Google Ads / Meta Ads"
									})]
								}),
								ads.rows.length ? jsxs(Fragment, { children: [jsx("div", {
									className: "opm-ad-summary",
									children: [
										["Cliques", number(ads.clicks)],
										["Conversões atribuídas", number(ads.conversions)],
										["CPC observado", money(ads.cpc, data.currency)],
										["CPA observado", money(ads.cpa, data.currency)],
										["Leads qualificados", number(ads.qualified)]
									].map(([l, v]) => jsxs("div", { children: [jsx("span", { children: l }), jsx("strong", { children: v })] }, l))
								}), jsx("div", {
									className: "opm-table-wrap",
									children: jsxs("table", { children: [jsx("thead", { children: jsxs("tr", { children: [
										jsx("th", { children: "Campanha / fonte" }),
										jsx("th", { children: "Período" }),
										jsx("th", { children: "Investimento" }),
										jsx("th", { children: "Cliques" }),
										jsx("th", { children: "Conv. atribuídas" }),
										jsx("th", { children: "CPC" }),
										jsx("th", { children: "CPA" })
									] }) }), jsx("tbody", { children: ads.rows.map((r) => jsxs("tr", { children: [
										jsxs("td", { children: [jsx("strong", { children: r.campaignName }), jsxs("small", { children: [
											channelNames[r.platform],
											" · ",
											r.source === "manual" ? "Lançamento manual" : "Fonte comprovada"
										] })] }),
										jsxs("td", { children: [
											date(r.from),
											" - ",
											date(r.to),
											jsx("small", { children: r.coverage === "partial" ? "Provisório" : "Período encerrado" })
										] }),
										jsx("td", { children: money(r.spendCents / 100) }),
										jsx("td", { children: number(r.clicks) }),
										jsx("td", { children: number(r.conversions) }),
										jsx("td", { children: money(r.clicks ? r.spendCents / 100 / r.clicks : null) }),
										jsx("td", { children: money(r.conversions ? r.spendCents / 100 / r.conversions : null) })
									] }, r.id)) })] })
								})] }) : jsx(Empty, {
									icon: "ads",
									title: "Sem relatório disponível",
									text: "Quando a OnPlay publicar a análise desta empresa, os resultados aparecerão aqui."
								}),
								ads.overlaps ? jsx("p", {
									className: "opm-status",
									children: "Há relatórios que ultrapassam o período selecionado. Eles não foram rateados nem somados. Selecione o intervalo completo do relatório."
								}) : null,
								jsx("p", {
									className: "opm-caption",
									children: "Últimas 48 horas provisórias; o prazo pode ser maior conforme a ação. Clique não comprova conversa, consulta ou venda."
								}),
								reportEditor
							]
						}),
						jsxs("details", {
							className: "opm-panel opm-diagnostics",
							id: "configuracao",
							children: [jsx("summary", { children: "Fontes, cobertura e configurações" }), jsxs("div", {
								className: "opm-diagnostic-body",
								children: [
									sources,
									jsx("p", { children: data.notice }),
									jsxs("p", { children: [
										"Atualização: ",
										data.updatedAt ? new Date(data.updatedAt).toLocaleString("pt-BR", { timeZone: data.timezone }) : "Indisponível",
										" · ",
										data.timezone
									] }),
									jsx("dl", { children: data.metrics.filter((m) => m.unit === "count").map((m) => jsxs("div", { children: [jsx("dt", { children: m.label }), jsx("dd", { children: m.note })] }, m.key)) }),
									details
								]
							})]
						}),
						jsxs("footer", {
							className: "opm-footer",
							children: [
								jsx(Brand, {}),
								jsxs("p", { children: [data.clientName, " · Seus resultados, com clareza."] }),
								jsx("span", { children: "Dados privados da empresa selecionada" })
							]
						})
					]
				}),
				master ? jsxs("nav", {
					className: "opm-bottom-nav",
					"aria-label": "Marketing no celular",
					children: [nav.slice(0, 4).map(([icon, label, id]) => jsxs("a", {
						href: `#${id}`,
						children: [jsx(Icon, { name: icon }), jsx("span", { children: label === "Site e visitantes" ? "Site" : label === "Leads e contatos" ? "Contatos" : label === "Tráfego pago" ? "Tráfego" : "Visão geral" })]
					}, label)), jsxs("a", {
						href: "#relatorios",
						children: [jsx(Icon, { name: "report" }), jsx("span", { children: "Relatórios" })]
					})]
				}) : null
			]
		})]
	});
}
//#endregion
export { MarketingDashboard };
