import express from 'express';
import axios from 'axios';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { customAlphabet } from 'nanoid';
import { stringify } from 'csv-stringify/sync';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import pg from 'pg';
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PI_API_BASE = 'https://api.minepi.com/v2';
const { PI_API_KEY, ADMIN_PASSWORD='change-me', DATABASE_URL, PORT=3000, TAKER_FEE_BPS=20, MAKER_FEE_BPS=10, FEE_TREASURY_UID='FEE_TREASURY',
  TELEGRAM_BOT_TOKEN='', TELEGRAM_CHAT_ID='', SMTP_HOST='', SMTP_PORT=587, SMTP_USER='', SMTP_PASS='', EMAIL_TO='' } = process.env;

const app = express();
app.use(helmet()); app.use(cors()); app.use(express.json({limit:'1mb'})); app.use(express.static(path.join(__dirname,'public'))); app.use(morgan('tiny'));
const rl = new RateLimiterMemory({ points: 200, duration: 60 }); app.use(async (req,res,next)=>{ try{ await rl.consume(req.ip); next(); } catch { res.status(429).json({error:'Too many requests'}); }});

const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: DATABASE_URL ? { rejectUnauthorized:false } : false });
const nid = customAlphabet('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz', 16);
const initSql = fs.readFileSync(path.join(__dirname,'db.sql'),'utf8');
pool.query(initSql).catch(console.error);
pool.query(`insert into users(uid,username,is_admin,is_operator,accepted_terms) values($1,$2,true,true,true) on conflict(uid) do nothing`, [FEE_TREASURY_UID,'fee_treasury']).catch(()=>{});
pool.query(`insert into balances(uid,asset,amount) values($1,'PI',0) on conflict(uid,asset) do nothing`, [FEE_TREASURY_UID]).catch(()=>{});

async function audit(event, payload){ await pool.query(`insert into audit(id,event,payload) values($1,$2,$3)`, [nid(),event,payload||{}]); }
async function ensureUser(uid, username){ await pool.query(`insert into users(uid,username) values($1,$2) on conflict(uid) do update set username=excluded.username, updated_at=now()`, [uid,username]);
  await pool.query(`insert into balances(uid,asset,amount) values($1,'PI',0) on conflict(uid,asset) do nothing`, [uid]);
  await pool.query(`insert into balances(uid,asset,amount) values($1,'USDX',0) on conflict(uid,asset) do nothing`, [uid]);
  const {rows}=await pool.query(`select * from users where uid=$1`,[uid]); return rows[0]; }
async function getBal(uid,asset){ const {rows}=await pool.query(`select amount from balances where uid=$1 and asset=$2`,[uid,asset]); return Number(rows?.[0]?.amount||0); }
async function addBal(uid,asset,delta){ await pool.query(`insert into balances(uid,asset,amount) values($1,$2,0) on conflict(uid,asset) do nothing`,[uid,asset]); await pool.query(`update balances set amount=amount+$3 where uid=$1 and asset=$2`,[uid,asset,delta]); }
function requireAdmin(req,res,next){ const tok=(req.headers['x-admin-token']||'').toString(); if(tok!==ADMIN_PASSWORD) return res.status(403).json({error:'Forbidden'}); next(); }

async function notify(title,msg){
  try{
    if(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID){
      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:TELEGRAM_CHAT_ID,text:`📣 ${title}\n${msg}`})});
    }
    if(SMTP_HOST && SMTP_USER && SMTP_PASS && EMAIL_TO){
      const tr=nodemailer.createTransport({host:SMTP_HOST,port:SMTP_PORT,secure:SMTP_PORT==465,auth:{user:SMTP_USER,pass:SMTP_PASS}});
      await tr.sendMail({from:`"Pi Exchange" <${SMTP_USER}>`,to:EMAIL_TO,subject:title,text:msg});
    }
  }catch(e){ console.error('notify failed',e.message); }
}

app.post('/api/session/pi', async (req,res)=>{
  const { accessToken, username, uid } = req.body||{}; if(!accessToken) return res.status(400).json({error:'Missing accessToken'});
  try{ const me=await axios.get(`${PI_API_BASE}/me`,{headers:{authorization:`Bearer ${accessToken}`}}); const U=me?.data?.uid||uid, UN=me?.data?.username||username; const user=await ensureUser(U,UN); await audit('session_ok',{uid:U}); res.json({ok:true,user}); }
  catch(e){ await audit('session_fail',{error:e.response?.data||e.message}); res.status(401).json({error:'Invalid token'}); }
});

app.get('/api/users/:uid', async (req,res)=>{
  const {rows}=await pool.query(`select u.uid,u.username,u.accepted_terms,coalesce(pi.amount,0) as pi,coalesce(usdx.amount,0) as usdx from users u left join balances pi on(u.uid=pi.uid and pi.asset='PI') left join balances usdx on(u.uid=usdx.uid and usdx.asset='USDX') where u.uid=$1`,[req.params.uid]);
  if(!rows[0]) return res.status(404).json({error:'User not found'});
  res.json({ ok:true, user:{ uid:rows[0].uid, username:rows[0].username, accepted_terms:rows[0].accepted_terms, balances:{ PI:Number(rows[0].pi), USDX:Number(rows[0].usdx) } } });
});
app.post('/api/users/:uid/accept-terms', async (req,res)=>{ await pool.query(`update users set accepted_terms=true,updated_at=now() where uid=$1`,[req.params.uid]); res.json({ok:true}); });

app.post('/api/payments/approve', async (req,res)=>{
  const { paymentId, uid, amount } = req.body||{}; if(!paymentId) return res.status(400).json({error:'Missing paymentId'});
  try{ await axios.post(`${PI_API_BASE}/payments/${paymentId}/approve`,null,{headers:{authorization:`key ${PI_API_KEY}`}});
    await pool.query(`insert into payments(payment_id,uid,amount,status) values($1,$2,$3,'APPROVED') on conflict(payment_id) do nothing`,[paymentId,uid,amount]);
    await audit('approve_ok',{paymentId,uid,amount}); res.json({ok:true});
  }catch(e){ await audit('approve_fail',{paymentId,error:e.response?.data||e.message}); res.status(400).json({error:'Approve failed'}); }
});
app.post('/api/payments/complete', async (req,res)=>{
  const { paymentId, txId } = req.body||{}; if(!paymentId||!txId) return res.status(400).json({error:'Missing paymentId or txId'});
  try{ await axios.post(`${PI_API_BASE}/payments/${paymentId}/complete`,{txid:txId},{headers:{authorization:`key ${PI_API_KEY}`}});
    const {rows}=await pool.query(`update payments set status='COMPLETED',txid=$2,completed_at=now() where payment_id=$1 returning uid,amount`,[paymentId,txId]);
    const r=rows[0]; if(r?.uid&&r?.amount) await addBal(r.uid,'PI',Number(r.amount)); await audit('complete_ok',{paymentId,txId,amount:r?.amount||0}); res.json({ok:true});
  }catch(e){ await audit('complete_fail',{paymentId,error:e.response?.data||e.message}); res.status(400).json({error:'Complete failed'}); }
});

async function pairId(symbol='USDX/PI'){ const {rows}=await pool.query(`select id from pairs where symbol=$1`,[symbol]); return rows[0]?.id; }
app.get('/api/orderbook', async (req,res)=>{
  const pid = await pairId(req.query.symbol||'USDX/PI');
  const bids=(await pool.query(`select id,price,(qty-filled) as qty from orders where pair_id=$1 and status='OPEN' and side='BUY' and (qty-filled)>0 order by price desc,created_at asc limit 50`,[pid])).rows;
  const asks=(await pool.query(`select id,price,(qty-filled) as qty from orders where pair_id=$1 and status='OPEN' and side='SELL' and (qty-filled)>0 order by price asc,created_at asc limit 50`,[pid])).rows;
  const trades=(await pool.query(`select price,qty,extract(epoch from ts)*1000 as ts from trades where pair_id=$1 order by ts desc limit 50`,[pid])).rows;
  res.json({ ok:true, bids, asks, trades });
});

app.post('/api/orders', async (req,res)=>{
  const { uid, side, price, qty, symbol } = req.body||{};
  if(!uid) return res.status(400).json({error:'uid required'});
  const s=String(side||'').toUpperCase(); const P=Number(price), Q=Number(qty); if(!['BUY','SELL'].includes(s)||!(P>0)||!(Q>0)) return res.status(400).json({error:'Invalid order'});
  const pid=await pairId(symbol||'USDX/PI');
  const user = (await pool.query(`select accepted_terms from users where uid=$1`,[uid])).rows[0]; if(!user?.accepted_terms) return res.status(403).json({error:'Accept terms first'});
  if(s==='BUY'){ const need=P*Q; if(await getBal(uid,'PI')<need) return res.status(400).json({error:'Insufficient PI'}); await addBal(uid,'PI',-need); } else { if(await getBal(uid,'USDX')<Q) return res.status(400).json({error:'Insufficient USDX'}); await addBal(uid,'USDX',-Q); }
  const id=nid(); await pool.query(`insert into orders(id,uid,pair_id,side,price,qty,filled,status) values($1,$2,$3,$4,$5,$6,0,'OPEN')`,[id,uid,pid,s,P,Q]);
  await match(pid); res.json({ ok:true, order_id:id });
});

app.post('/api/orders/:id/cancel', async (req,res)=>{
  const { uid } = req.body||{}; const {rows}=await pool.query(`select * from orders where id=$1`,[req.params.id]); const o=rows[0];
  if(!o) return res.status(404).json({error:'Not found'}); if(o.uid!==uid) return res.status(403).json({error:'Forbidden'}); if(o.status!=='OPEN') return res.status(400).json({error:'Not open'});
  await pool.query(`update orders set status='CANCELED' where id=$1`,[o.id]);
  if(o.side==='BUY'){ await addBal(o.uid,'PI',(o.qty-o.filled)*o.price); } else { await addBal(o.uid,'USDX',(o.qty-o.filled)); }
  res.json({ ok:true });
});

async function match(pid){
  const bids=(await pool.query(`select * from orders where pair_id=$1 and status='OPEN' and side='BUY' order by price desc,created_at asc`,[pid])).rows;
  const asks=(await pool.query(`select * from orders where pair_id=$1 and status='OPEN' and side='SELL' order by price asc,created_at asc`,[pid])).rows;
  for(const b of bids){
    for(const a of asks){
      if(b.status!=='OPEN'||a.status!=='OPEN') continue;
      if(b.price < a.price) break;
      const qty=Math.min(Number(b.qty-b.filled), Number(a.qty-a.filled)); if(qty<=0) continue;
      const price=Number(a.price); const notionalPI=qty*price;
      const taker = b.created_at > a.created_at ? b : a;
      const taker_fee = (taker.id===b.id ? Number(TAKER_FEE_BPS) : Number(MAKER_FEE_BPS)) * notionalPI / 10000;
      const maker_fee = (taker.id===b.id ? Number(MAKER_FEE_BPS) : Number(TAKER_FEE_BPS)) * notionalPI / 10000;
      await addBal(b.uid,'USDX', qty); await addBal(a.uid,'USDX', -qty);
      await addBal(a.uid,'PI', notionalPI - maker_fee); await addBal(b.uid,'PI', -taker_fee);
      await addBal(FEE_TREASURY_UID,'PI', taker_fee + maker_fee);
      await pool.query(`update orders set filled=filled+$2, status=case when filled+$2>=qty then 'FILLED' else 'OPEN' end where id=$1`,[b.id,qty]);
      await pool.query(`update orders set filled=filled+$2, status=case when filled+$2>=qty then 'FILLED' else 'OPEN' end where id=$1`,[a.id,qty]);
      await pool.query(`insert into trades(id,pair_id,price,qty,maker_side,buy_order_id,sell_order_id,taker_uid,maker_uid,fee_pi) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [nid(),pid,price,qty,'SELL',b.id,a.id,taker.uid,(taker.uid===b.uid?a.uid:b.uid),taker_fee+maker_fee]);
    }
  }
}

app.post('/api/withdrawals', async (req,res)=>{
  const { uid, amount, pi_address } = req.body||{}; const amt=Number(amount||0);
  if(!uid||!(amt>0)||!pi_address) return res.status(400).json({error:'Bad request'});
  if(await getBal(uid,'PI')<amt) return res.status(400).json({error:'Insufficient balance'});
  await addBal(uid,'PI',-amt); const id=nid();
  await pool.query(`insert into withdrawals(id,uid,asset,amount,pi_address,status) values($1,$2,'PI',$3,$4,'PENDING')`,[id,uid,amt,pi_address]);
  await audit('withdraw_req',{id,uid,amt});
  res.json({ ok:true, id });
});
app.get('/api/admin/withdrawals', requireAdmin, async (req,res)=>{ const {rows}=await pool.query(`select * from withdrawals order by created_at desc limit 200`); res.json({ ok:true, withdrawals:rows }); });
app.post('/api/admin/withdrawals/:id/mark', requireAdmin, async (req,res)=>{
  const { status, note } = req.body||{}; if(!['APPROVED','SENT','REJECTED'].includes(status)) return res.status(400).json({error:'Bad status'});
  const {rows}=await pool.query(`select * from withdrawals where id=$1`,[req.params.id]); const w=rows[0]; if(!w) return res.status(404).json({error:'Not found'});
  await pool.query(`update withdrawals set status=$2, note=$3, updated_at=now() where id=$1`,[w.id,status,note||'']);
  if(status==='REJECTED') await addBal(w.uid,'PI',Number(w.amount||0));
  await audit('withdraw_mark',{id:w.id,status});
  res.json({ ok:true });
});

app.get('/api/admin/export/audit.csv', requireAdmin, async (req,res)=>{
  const {rows}=await pool.query(`select id,ts,event,payload from audit order by ts desc limit 1000`);
  const csv=stringify(rows,{header:true}); res.setHeader('Content-Type','text/csv'); res.setHeader('Content-Disposition','attachment; filename="audit.csv"'); res.send(csv);
});

app.get('*', (req,res)=> res.sendFile(path.join(__dirname,'public','index.html')) );
app.listen(PORT, ()=> console.log(`Server listening on http://localhost:${PORT}`));
