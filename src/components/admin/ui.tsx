import {useEffect,useState} from 'react';
import type {CSSProperties,ReactNode} from 'react';
export function Card({children,style}:{children:ReactNode;style?:CSSProperties}){return <section className="card" style={{padding:24,...style}}>{children}</section>}
export function Empty({title,children}:{title:string;children?:ReactNode}){return <div className="empty"><div className="display" style={{fontSize:22}}>{title}</div>{children&&<div className="muted" style={{marginTop:6}}>{children}</div>}</div>}
export function Status({children}:{children:ReactNode}){return <span className="pill status-pill">{children}</span>}
export function Countdown({closesAt}:{closesAt?:string|null}){const[now,setNow]=useState(Date.now());useEffect(()=>{if(!closesAt)return;const id=window.setInterval(()=>setNow(Date.now()),250);return()=>window.clearInterval(id)},[closesAt]);if(!closesAt)return <span>—</span>;const ms=Math.max(0,new Date(closesAt).getTime()-now);const sec=Math.ceil(ms/1000);return <span>{Math.floor(sec/60)}:{String(sec%60).padStart(2,'0')}</span>}
