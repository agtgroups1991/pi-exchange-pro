import React, { useEffect, useState } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { Coins, ArrowRightLeft } from 'lucide-react'

const fmt = n => Number(n||0).toFixed(4).replace(/\.0+$|(?<=\.[0-9]*[1-9])0+$/,'')
const api = (p,opts={}) => fetch(p,{ headers:{'Content-Type':'application/json',...(opts.headers||{})}, ...opts }).then(r=>r.json())

export default function App(){
  const [me,setMe]=useState(null); const [bids,setBids]=useState([]); const [asks,setAsks]=useState([]); const [trades,setTrades]=useState([])
  const [depAmt,setDepAmt]=useState(''); const [wAddr,setWAddr]=useState(''); const [wAmt,setWAmt]=useState('')
  const [price,setPrice]=useState(''); const [qty,setQty]=useState(''); const [side,setSide]=useState('BUY')

  const scopes=['payments','username']
  function onIncompletePaymentFound(payment){ const pid=payment.identifier, tx=payment?.transaction?.txid; if(pid&&tx){ api('/api/payments/complete',{method:'POST',body:JSON.stringify({paymentId:pid,txId:tx})}) } }
  async function login(){
    try{
      const auth=await Pi.authenticate(scopes,onIncompletePaymentFound)
      const res=await api('/api/session/pi',{method:'POST',body:JSON.stringify({accessToken:auth.accessToken,username:auth.user?.username,uid:auth.user?.uid})})
      setMe({ uid:res.user.uid, username:res.user.username }); refreshMe(res.user.uid)
    }catch(e){ alert('Hãy mở bằng Pi Browser & cấu hình đúng Production URL trong Portal.') }
  }

  async function refreshMe(uid=me?.uid){ if(!uid) return; const j=await api('/api/users/'+uid); if(j.ok) setMe({ uid:uid, username:j.user.username, balances:j.user.balances, accepted:j.user.accepted_terms }) }
  async function refreshOB(){ const j=await api('/api/orderbook'); if(j.ok){ setBids(j.bids); setAsks(j.asks); setTrades(j.trades.map(t=>({ ...t, time:new Date(+t.ts).toLocaleTimeString() }))) } }
  async function deposit(){ if(!me) return alert('Đăng nhập trước'); const amount=parseFloat(depAmt||'0'); if(!(amount>0)) return alert('Số Pi không hợp lệ');
    await Pi.createPayment({ amount, memo:`Deposit ${amount} π`, metadata:{type:'deposit'} },{
      onReadyForServerApproval: pid=>api('/api/payments/approve',{method:'POST',body:JSON.stringify({paymentId:pid,uid:me.uid,amount})}),
      onReadyForServerCompletion: (pid,tx)=>api('/api/payments/complete',{method:'POST',body:JSON.stringify({paymentId:pid,txId:tx})}).then(()=>refreshMe(me.uid))
    })
  }
  async function place(){ if(!me) return alert('Đăng nhập trước'); const P=parseFloat(price||'0'), Q=parseFloat(qty||'0'); if(!(P>0&&Q>0)) return alert('Giá/KL không hợp lệ');
    const j=await api('/api/orders',{method:'POST',body:JSON.stringify({uid:me.uid,side,price:P,qty:Q,symbol:'USDX/PI'})}); if(!j.ok) return alert(j.error||'Lỗi'); setPrice(''); setQty(''); refreshOB(); refreshMe() }

  useEffect(()=>{ refreshOB(); const t=setInterval(refreshOB,4000); return ()=>clearInterval(t) },[])

  return <div className="max-w-4xl mx-auto p-4 space-y-4">
    <div className="flex items-center justify-between">
      <div className="text-xl font-semibold flex items-center gap-2"><Coins className="inline-block" /> Pi Exchange Pro</div>
      <div className="flex items-center gap-2">
        <div className="text-sm opacity-70">{me? `Đã đăng nhập: ${me.username}` : 'Chưa đăng nhập'}</div>
        <button className="btn" onClick={login}>Đăng nhập Pi</button>
      </div>
    </div>

    <div className="card space-y-2">
      <div className="text-sm opacity-80">PI: <b>{fmt(me?.balances?.PI)}</b> • USDX: <b>{fmt(me?.balances?.USDX)}</b></div>
      <div className="flex gap-2">
        <input className="flex-1" placeholder="Số Pi nạp" value={depAmt} onChange={e=>setDepAmt(e.target.value)} />
        <button className="btn" onClick={deposit}>Nạp Pi</button>
      </div>
      <div className="flex gap-2">
        <input className="flex-1" placeholder="Địa chỉ ví Pi (Mainnet)" value={wAddr} onChange={e=>setWAddr(e.target.value)} />
        <input className="w-32" placeholder="Số Pi rút" value={wAmt} onChange={e=>setWAmt(e.target.value)} />
      </div>
      <div className="flex gap-2">
        <select value={side} onChange={e=>setSide(e.target.value)} className="w-28">
          <option value="BUY">BUY (mua USDX)</option>
          <option value="SELL">SELL (bán USDX)</option>
        </select>
        <input className="w-28" placeholder="Giá (PI)" value={price} onChange={e=>setPrice(e.target.value)} />
        <input className="w-28" placeholder="KL (USDX)" value={qty} onChange={e=>setQty(e.target.value)} />
        <button className="btn" onClick={place}><ArrowRightLeft className="inline-block mr-1" size={16}/> Đặt</button>
      </div>
      <div className="h-40">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={trades.slice().reverse()}>
            <XAxis dataKey="time" hide /><YAxis hide /><Tooltip />
            <Line type="monotone" dataKey="price" dot={false} strokeWidth={2} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  </div>
}
