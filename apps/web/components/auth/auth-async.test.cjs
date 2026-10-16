const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), ts = require("typescript");
const NativeFormData = global.FormData, NativeFetch=global.fetch, NativeWindow=global.window;
function load(file, dependencies = {}) {
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, out = { exports: {} };
  new Function("require", "module", "exports", code)(name => dependencies[name] ?? require(name), out, out.exports); return out.exports;
}
const policy = load(path.resolve(__dirname, "../../lib/auth/password-policy.ts"));
function harness(mode, result = { error: null }) {
  let cursor = 0; const states = [], calls = [], navigations = [];
  global.FormData = class extends NativeFormData { constructor(form) { super(); if (form) for (const [key,value] of form.entries()) this.append(key,value); } };
  const invoke = async (method, data, options) => { calls.push({ method, data, options }); if (typeof result === "function") return result(); if (result instanceof Error) throw result; return result; };
  const auth = { signInWithPassword: data => invoke("login",data), signUp: data => invoke("signup",data), resetPasswordForEmail: (data,options) => invoke("recovery",data,options), updateUser: data => invoke("update",data), async signOut() { calls.push({ method:"signOut" }); return { error:null }; } };
  if(mode==="signup")global.fetch=async(url,options)=>{assert.equal(url,"/auth/signup");const result=await invoke("signup",JSON.parse(options.body));return{ok:!result.error,json:async()=>result.error?{error:policy.friendlyAuthError(result.error,"signup")}:{ok:true}};};
  global.window={location:{assign:dest=>navigations.push(dest)}};
  const reset = mode === "reset", dependencies = {
    react: { useEffect() {}, useRef: () => ({ current:false }), useState(initial) { const index=cursor++;states[index]=reset&&index===2?true:initial;return [states[index],value=>{states[index]=value;}]; } },
    "react/jsx-runtime": { jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props}) },
    "next/navigation": { useRouter:()=>({replace:dest=>navigations.push(dest),refresh(){}}) },
    "@/lib/auth/password-policy":policy,"@/lib/auth/password-link":{parsePasswordLink:()=>({kind:"none"}),passwordLinkError:()=>"Link inválido"},
    "@/lib/auth/navigation":{AUTHENTICATED_HOME:"/automacao"},
    "@/lib/auth-email-url":{getCoinOpsPasswordRedirect:()=>"https://cripto-flax.vercel.app/redefinir-senha",getCoinOpsAuthCallback:()=>"https://cripto-flax.vercel.app/auth/callback?next=%2Fautomacao"},
    "@/lib/supabase/browser":{createClient:()=>({auth}),isSupabaseConfigured:()=>true},
  };
  const exports = load(path.join(__dirname,reset?"password-reset-form.tsx":"auth-form.tsx"),dependencies),component=reset?exports.PasswordResetForm():exports.AuthForm({mode,redirectTo:"/automacao"});
  return {async submit(patch={}){const form=new NativeFormData();for(const[key,value]of Object.entries({email:"qa@example.test",password:"test-only-password",confirmation:"test-only-password",companyName:"Empresa QA",ownerName:"Responsável QA",whatsapp:"(67) 99999-9999",...patch}))form.set(key,value);await component.props.onSubmit({preventDefault(){},currentTarget:form});return form;},states,calls,navigations,component};
}
test.afterEach(()=>{global.FormData=NativeFormData;global.fetch=NativeFetch;global.window=NativeWindow;});
for(const mode of ["login","signup","recovery"])test(`${mode} retains pending until Auth settles and locks duplicate submits`,async()=>{
  let finish;const h=harness(mode,()=>new Promise(resolve=>{finish=resolve;})),first=h.submit();await h.submit();assert.equal(h.calls.length,1);assert.equal(h.states[0],true);finish(mode==="signup"?{data:{session:null},error:null}:{error:null});await first;assert.equal(h.states[0],false);
});
test("signup sends only the five fields to the server and opens immediate onboarding",async()=>{
  const h=harness("signup",{data:{session:null},error:null});await h.submit();assert.equal(h.calls[0].data.email,"qa@example.test");assert.equal(h.calls[0].data.company,"Empresa QA");assert.equal(h.calls[0].data.owner,"Responsável QA");assert.equal(h.calls[0].data.whatsapp,"+5567999999999");assert.deepEqual(h.navigations,["/primeiros-passos"]);assert.equal(h.calls[0].data.password,"test-only-password");assert.equal(h.states[0],false);
});
test("rejected Auth clears pending, keeps the original form and hides provider details",async()=>{
  const h=harness("signup",new Error("sensitive-provider-detail")),form=await h.submit();assert.equal(h.states[0],false);assert.equal(form.get("companyName"),"Empresa QA");assert.equal(form.get("password"),"test-only-password");assert.ok(!h.states[1].includes("sensitive"));assert.deepEqual(h.navigations,[]);assert.equal(h.component.props.action,undefined);
});
test("signup provider error never reports success",async()=>{const h=harness("signup",{error:{code:"email_address_invalid"}});await h.submit();assert.equal(h.states[0],false);assert.equal(h.states[1],"Digite um e-mail válido.");assert.equal(h.states[2],null);});
test("short signup password fails before Auth",async()=>{const h=harness("signup");await h.submit({password:"123"});assert.deepEqual(h.calls,[]);assert.equal(h.states[0],false);assert.match(h.states[1],/8 caracteres/);});
test("password update holds pending and sends only one update",async()=>{
  let finish;const h=harness("reset",()=>new Promise(resolve=>{finish=resolve;})),first=h.submit();await h.submit();assert.equal(h.calls.filter(c=>c.method==="update").length,1);assert.equal(h.states[0],true);finish({error:null});await first;assert.equal(h.states[0],false);assert.deepEqual(h.navigations,["/login?auth=password-updated"]);
});
test("rejected password update releases the form without redirect or raw error",async()=>{const h=harness("reset",new Error("sensitive-provider-detail"));await h.submit();assert.equal(h.states[0],false);assert.ok(!h.states[1].includes("sensitive"));assert.deepEqual(h.navigations,[]);});
