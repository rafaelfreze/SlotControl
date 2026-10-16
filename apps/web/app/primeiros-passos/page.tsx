import { EmailOwnershipBanner } from "@/components/auth/email-ownership-banner";
import { emailOwnershipPending } from "@/lib/auth/email-ownership";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role";
import { CoinOpsBrand } from "@/components/app/coinops-brand";
import { ViewerSignOut } from "@/app/meu-coinops/sign-out";

export const dynamic = "force-dynamic";
export default async function ViewerFirstSteps() {
  const user=(await createClient().auth.getUser()).data.user;
  if(!user) redirect("/login?redirectTo=/primeiros-passos");
  if(user.app_metadata?.coinops_role!=="VIEWER") redirect("/automacao");
  const binding=await createServiceRoleClient().from("viewer_access").select("status,exchange_account_id,company_name,owner_name").eq("user_id",user.id).maybeSingle();
  if(binding.error||!binding.data||binding.data.status!=="ACTIVE") redirect("/acesso-suspenso");
  if(binding.data.exchange_account_id) redirect("/meu-coinops");
  return <main className="page-shell auth-shell"><section className="auth-card">
    <EmailOwnershipBanner pending={emailOwnershipPending(user,"coinops")}/><CoinOpsBrand subtitle="Primeiros passos" /><h1>Bem-vindo ao CoinOps</h1>
    <p>{binding.data.company_name} · {binding.data.owner_name}</p>
    <p role="status">Cadastro pronto. Aguardando vínculo da sua conta pelo administrador.</p>
    <ol className="auth-form"><li><strong>Prepare sua conta Binance.</strong> Confira seus dados e a segurança da conta na própria Binance.</li>
      <li><strong>Combine a configuração com a OnPlay.</strong> O administrador cria o vínculo correto e orienta credenciais e permissões pela configuração segura. Não envie senha ou chave secreta por WhatsApp.</li>
      <li><strong>Acompanhe o painel.</strong> Quando o vínculo estiver pronto, Meu CoinOps mostrará somente sua conta e seus resultados disponíveis.</li>
      <li><strong>Ativação é uma etapa separada.</strong> O cadastro não ativa motores nem movimenta capital; as verificações operacionais continuam obrigatórias.</li></ol>
    <p>Seu e-mail e senha já funcionam. Você pode trocar a senha quando quiser.</p>
    <div className="nav-actions"><Link className="solid-link" href="/meu-coinops">Conferir configuração</Link><Link className="ghost-link" href="/redefinir-senha">Trocar senha</Link><ViewerSignOut /></div>
  </section></main>;
}
