import "server-only";
import { createHmac } from "node:crypto";
import type { User } from "@supabase/supabase-js";
import { createServiceRoleClient as createAdmin } from "@/lib/supabase/service-role";
import { createClient as createSession } from "@/lib/supabase/server";
import { assertSignupRequest, pendingOwnership, validateSignup, verifiedOwnership, emailOwnershipPending } from "./email-ownership";
const PRODUCT="coinops";
const respond=(data:unknown,status=200)=>Response.json(data,{status,headers:{"cache-control":"private, no-store"}});
function admin() {
 const endpoint=new URL(process.env.NEXT_PUBLIC_SUPABASE_URL??"");
 if(endpoint.origin!=="https://otdfpmsegjxpqrzisfmi.supabase.co"||endpoint.pathname!=="/"||endpoint.search||endpoint.hash||endpoint.username||endpoint.password||process.env.SUPABASE_DATA_SCHEMA!=="coinops")throw new Error("backend_unavailable");
 return createAdmin();
}
export async function signup(request:Request) {
 try {
  assertSignupRequest(request);
  const text=await request.text();if(Buffer.byteLength(text)>16384)return respond({error:"Cadastro inválido."},400);
  const raw=JSON.parse(text) as Record<string,unknown>;let input:ReturnType<typeof validateSignup>;
  try{input=validateSignup(raw);}catch(error){return respond({error:error instanceof Error?error.message:"Confira os dados."},400);}
  const db=admin(),key=process.env.SUPABASE_SERVICE_ROLE_KEY;if(!key)throw new Error("backend_unavailable");
  const hash=(value:string)=>createHmac("sha256",key).update(PRODUCT+":"+value).digest("hex");
  const source=request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim()??request.headers.get("x-real-ip")??"unknown";
  const rate=await db.rpc("consume_public_signup_attempt",{p_sourcehash:hash("source:"+source),p_emailhash:hash("email:"+input.email)});
  if(rate.error)return respond({error:"Cadastro temporariamente indisponível. Tente novamente em instantes."},503);
  if(rate.data!==true)return respond({error:"Muitas tentativas. Aguarde um pouco e tente novamente."},429);
  
  const created=await db.auth.admin.createUser({email:input.email,password:input.password,email_confirm:true,
   app_metadata:{onplay_email_ownership:pendingOwnership(PRODUCT,input.email)},
   user_metadata:{onplay_product:"coinops",company_name:input.company,owner_name:input.owner,whatsapp:input.whatsapp}});
  // Auth uniqueness makes duplicate submissions idempotent. Never adopt, confirm,
  // reset the password of, or change memberships on an existing email.
  if(created.error||!created.data.user)return respond({error:"Não foi possível criar a conta. Se já possui cadastro, entre com sua senha ou use a recuperação."},409);
  const client=await createSession();
  const signed=await client.auth.signInWithPassword({email:input.email,password:input.password});
  if(signed.error||!signed.data.session)return respond({error:"Conta criada. Entre com o e-mail e a senha escolhidos.",accountCreated:true},503);
  return respond({ok:true,next:"/primeiros-passos"},201);
 }catch{return respond({error:"Não foi possível concluir o cadastro. Tente novamente em instantes."},400);}
}
export async function requestOwnership(request:Request) {
 try {
  assertSignupRequest(request);
  const client=await createSession(),auth=await client.auth.getUser(),user=auth.data.user;
  if(auth.error||!user)return respond({error:"Entre na sua conta para confirmar o e-mail."},401);
  if(!emailOwnershipPending(user,PRODUCT))return respond({message:"Seu e-mail já está confirmado."});
  const sent=await client.auth.signInWithOtp({email:user.email!,options:{shouldCreateUser:false,emailRedirectTo:new URL("/auth/callback?intent=ownership",new URL(request.url).origin).href}});
  if(sent.error)return respond({error:"Não foi possível enviar agora. Você pode continuar usando o sistema e tentar novamente depois."},503);
  return respond({message:"Enviamos um link para confirmar seu e-mail. Você pode continuar usando o sistema."});
 }catch{return respond({error:"Não foi possível enviar agora. Você pode continuar usando o sistema."},400);}
}
export async function markOwnershipVerified(user:User) {
 const db=admin(),current=await db.auth.admin.getUserById(user.id);
 if(current.error||!current.data.user)return false;
 const metadata=verifiedOwnership(current.data.user,PRODUCT,new Date().toISOString());
 if(!metadata)return !emailOwnershipPending(current.data.user,PRODUCT);
 const saved=await db.auth.admin.updateUserById(user.id,{app_metadata:metadata});
 return !saved.error;
}

