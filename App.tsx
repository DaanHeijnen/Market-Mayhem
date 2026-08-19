import {BrowserRouter,Navigate,Route,Routes,useParams} from 'react-router-dom';
import {AdminApp} from './components/admin/AdminApp';import {BigScreen} from './components/broadcast/BigScreen';import {MobileApp} from './components/mobile/MobileApp';import {JoinPage} from './components/mobile/JoinPage';import './styles/tokens.css';
const n=(v:string|undefined)=>Number(v||1);
function AdminRoute(){const p=useParams();return <AdminApp gameId={n(p.gameId)}/>};function ScreenRoute(){const p=useParams();return <BigScreen gameId={n(p.gameId)}/>};function PlayRoute(){const p=useParams();return <MobileApp gameId={n(p.gameId)}/>};
export default function App(){return <BrowserRouter><Routes><Route path="/admin/:gameId/*" element={<AdminRoute/>}/><Route path="/screen/:gameId" element={<ScreenRoute/>}/><Route path="/play/:gameId/*" element={<PlayRoute/>}/><Route path="/join/:token" element={<JoinPage/>}/><Route path="*" element={<Navigate to="/screen/1" replace/>}/></Routes></BrowserRouter>}
