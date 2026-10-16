"use client";
import {useState} from "react";
export function EmailOwnershipBanner({pending}:{pending:boolean}){
 const [busy,setBusy]=useState(false),[message,setMessage]=useState("");
 if(!pending)return null;
 async function send(){
  if(busy)return;setBusy(true);
  try{const response=await fetch("/auth/email-ownership/request",{method:"POST",headers:{"content-type":"application/json"},body:"{}"});
   const result=await response.json();setMessage(result.message??result.error??"Tente novamente depois.");
  }catch{setMessage("Não foi possível enviar agora. Você pode continuar usando o sistema.");}finally{setBusy(false);}
 }
 return <section role="status" className="form-success" style={{margin:"12px 0",padding:16}}>
  <strong>Confirme seu e-mail quando quiser</strong>
  <p>Seu acesso já está liberado. A confirmação é opcional e ajuda a manter seus dados de contato corretos.</p>
  <button type="button" className="ghost-button" disabled={busy} onClick={send} style={{minHeight:44}}>{busy?"Enviando…":"Confirmar meu e-mail"}</button>
  {message?<p>{message}</p>:null}
 </section>;
}

