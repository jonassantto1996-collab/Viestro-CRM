import {sessionClient} from '@/lib/supabase/server';
import {reply,body,sameOrigin} from '@/lib/http';
import {settingsValid} from '@/lib/validation';
import {ehDono,manterModeloDoDono} from '@/lib/dono.mjs';
export const dynamic='force-dynamic';
async function identity(db:any){const {data:{user}}=await db.auth.getUser();return user;}
async function bootstrap(db:any,user:any,invite?:string){const m=user.user_metadata||{};const {error}=await db.rpc('crm_bootstrap',{p_name:m.name||user.email?.split('@')[0]||'Usuário',p_company:m.company||'Minha empresa',p_niche:m.niche||'Serviços',p_invite:invite||m.invite||null});if(error)throw error;}
export async function GET(){try{const db=await sessionClient(),u=await identity(db);if(!u)return reply({user:null});await bootstrap(db,u);const {data:member,error:me}=await db.from('crm_members').select('*').eq('user_id',u.id).single();if(me)throw me;
 const results=await Promise.all([db.from('crm_companies').select('*').eq('id',member.company_id).single(),db.from('crm_members').select('*').eq('company_id',member.company_id),db.from('crm_records').select('id,kind,data').eq('company_id',member.company_id).order('created_at',{ascending:false}).limit(1000),db.from('crm_channels').select('provider,label,enabled'),db.from('crm_jobs').select('id,status,attempts,created_at').order('created_at',{ascending:false}).limit(20)]);
 for(const r of results)if(r.error)throw r.error;const [co,ms,rs,ch,jobs]=results;const records=(rs.data||[]) as any[];
 return reply({user:{id:u.id,email:u.email,name:member.name,tenant:member.company_id,role:member.role,owner:ehDono(u.email,process.env.CRM_DONO_EMAILS)},company:co.data,members:(ms.data as any[]).map(m=>({...m,id:m.user_id})),leads:records.filter(r=>r.kind==='leads').map(r=>({...r.data,id:r.id})),campaigns:records.filter(r=>r.kind==='campaigns').map(r=>({...r.data,id:r.id})),tasks:records.filter(r=>r.kind==='tasks').map(r=>({...r.data,id:r.id})),activity:records.filter(r=>r.kind==='activity').slice(0,30).map(r=>({...r.data,id:r.id})),channels:ch.data,jobs:jobs.data,limited:records.length===1000});
 }catch{return reply({error:'Não foi possível carregar sua empresa. Confira sua conexão e confirmação de e-mail.'},500)}}
export async function POST(req:Request){try{
 if(!sameOrigin(req))return reply({error:'Origem inválida'},403);const b=await body(req),db=await sessionClient(),action=b.action;
 if(action==='login'||action==='register'){
  const email=String(b.email||'').trim().toLowerCase(),password=String(b.password||'');if(password.length<10||password.length>200||!email.includes('@'))return reply({error:'Informe e-mail e senha com pelo menos 10 caracteres.'},400);
  if(action==='register'){
   if(!b.name?.trim()||(!b.invite&&!b.company?.trim()))return reply({error:'Informe seu nome e sua empresa.'},400);
   const {data,error}=await db.auth.signUp({email,password,options:{emailRedirectTo:`${process.env.NEXT_PUBLIC_SITE_URL||new URL(req.url).origin}/auth/confirm`,data:{name:String(b.name).slice(0,120),company:String(b.company||'').slice(0,120),niche:String(b.niche||'Serviços').slice(0,120),invite:String(b.invite||'').slice(0,100)}}});
   if(error)return reply({error:'Não foi possível cadastrar. Verifique os dados ou tente novamente mais tarde.'},error.status===429?429:400);
   if(!data.session)return reply({ok:true,confirmation:true});if(data.user)await bootstrap(db,data.user,b.invite);
  }else{const {data,error}=await db.auth.signInWithPassword({email,password});if(error)return reply({error:'E-mail ou senha incorretos, ou e-mail ainda não confirmado.'},error.status===429?429:401);await bootstrap(db,data.user,b.invite);}
  return reply({ok:true});
 }
 if(action==='recover'){await db.auth.resetPasswordForEmail(String(b.email||''),{redirectTo:`${process.env.NEXT_PUBLIC_SITE_URL||new URL(req.url).origin}/auth/confirm?next=recover`});return reply({ok:true,message:'Se o e-mail estiver cadastrado, você receberá instruções.'});}
 const user=await identity(db);if(!user)return reply({error:'Faça login para continuar.'},401);
 if(action==='logout'){await db.auth.signOut();return reply({ok:true});}
 if(action==='password'){if(String(b.password||'').length<10)return reply({error:'Use pelo menos 10 caracteres.'},400);const {error}=await db.auth.updateUser({password:b.password});if(error)return reply({error:'Não foi possível atualizar a senha.'},400);return reply({ok:true});}
 let result;
 if(action==='save')result=await db.rpc('crm_save',{p_kind:b.kind,p_data:b.data});
 else if(action==='settings'){if(!settingsValid(b.settings))return reply({error:'Revise etapas, critérios e pontuação.'},400);let ajustes=b.settings;const {data:{user:eu}}=await db.auth.getUser();if(!ehDono(eu?.email,process.env.CRM_DONO_EMAILS)){const {data:co}=await db.from('crm_companies').select('settings').maybeSingle();ajustes=manterModeloDoDono(ajustes,co?.settings);}result=await db.rpc('crm_settings',{p_name:b.name||null,p_niche:b.niche||null,p_settings:ajustes});}
 else if(action==='hook'||action==='member'){result=await db.rpc('crm_token',{p_email:action==='member'?b.email:null,p_name:action==='member'?b.name:null});if(result.error)return reply({error:result.error.message},400);return reply(action==='member'?{invite:`${process.env.NEXT_PUBLIC_SITE_URL||new URL(req.url).origin}/?invite=${result.data}`}:{token:result.data});}
 else return reply({error:'Ação inválida'},400);
 if(result.error)return reply({error:result.error.message},400);return reply({ok:true,id:result.data});
 }catch{return reply({error:'Não foi possível concluir. Confira os dados e tente novamente.'},400)}}
