export const OWNERSHIP_VERSION = 1;
export type Ownership = {version:1;product:string;status:"pending"|"verified";email:string;verified_at?:string};
export function pendingOwnership(product:string,email:string): Ownership {
 return {version:1,product,status:"pending",email:email.trim().toLowerCase()};
}
export function emailOwnershipPending(user:{email?:string|null;app_metadata?:Record<string,unknown>}|null, product:string) {
 const value=user?.app_metadata?.onplay_email_ownership as Partial<Ownership>|undefined;
 return value?.version===1 && value.product===product && value.status==="pending";
}
export function emailOwnershipVerified(user:{email?:string|null;email_confirmed_at?:string|null;app_metadata?:Record<string,unknown>}|null,product:string) {
 const value=user?.app_metadata?.onplay_email_ownership as Partial<Ownership>|undefined;
 if(!value)return Boolean(user?.email_confirmed_at);
 return value.version===1&&value.product===product&&value.status==="verified"&&value.email===user?.email?.toLowerCase()&&Boolean(value.verified_at);
}
export function verifiedOwnership(user:{email?:string|null;app_metadata?:Record<string,unknown>},product:string,now:string) {
 const value=user.app_metadata?.onplay_email_ownership as Partial<Ownership>|undefined;
 if(!emailOwnershipPending(user,product)||!user.email||value?.email!==user.email.toLowerCase()) return null;
 return {...user.app_metadata,onplay_email_ownership:{...value,status:"verified",verified_at:now}};
}
export function assertSignupRequest(request:Request) {
 const origin=request.headers.get("origin");
 if(!origin||origin!==new URL(request.url).origin||request.headers.get("sec-fetch-site")==="cross-site"
  ||!request.headers.get("content-type")?.startsWith("application/json")) throw new Error("request_denied");
}
export function validateSignup(input:Record<string,unknown>) {
 const email=String(input.email??"").trim().toLowerCase(),password=String(input.password??"");
 const company=String(input.company??"").trim(),owner=String(input.owner??"").trim();
 const phone=String(input.whatsapp??"").replace(/\D/g,"");
 const whatsapp="+"+((phone.length===12||phone.length===13)&&phone.startsWith("55")?phone:"55"+phone);
 if(!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(email)||email.length>254) throw new Error("Informe um e-mail válido.");
 if(password.length<8) throw new Error("Use pelo menos 8 caracteres.");
 if(company.length<2||company.length>120||owner.length<2||owner.length>120) throw new Error("Informe o nome da empresa e do responsável.");
 if(!/^\+55[1-9][0-9](9[0-9]{8}|[2-9][0-9]{7})$/.test(whatsapp)) throw new Error("Informe seu WhatsApp com DDD.");
 return {email,password,company,owner,whatsapp};
}

