import dotenv from 'dotenv';
import pool from '../db/db.js';
import cron from 'node-cron';

dotenv.config();

const BASE_LOCATIONS = [
  'Dallas-Downtown','Dallas-Uptown','Dallas-DeepEllum','Dallas-OakLawn','Dallas-Lakewood','Dallas-BishopArts',
  'Dallas-DesignDistrict','Dallas-KnoxHenderson','Dallas-LowerGreenville','Dallas-PrestonHollow','Dallas-NorthPark',
  'Plano-LegacyWest','Plano-Downtown','Plano-East','Frisco-Star','Frisco-Stonebriar','Frisco-Downtown',
  'Richardson-TelecomCorridor','Richardson-CanyonCreek','Garland-Firewheel','Garland-Downtown','Allen-WattersCreek',
  'McKinney-Downtown','McKinney-Stonebridge','Carrollton-Hebron','Carrollton-Downtown','Lewisville-OldTown',
  'TheColony-Grandscape','Addison-Circle','Irving-LasColinas','Irving-DfwAirport','Irving-ValleyRanch',
  'GrandPrairie-Epic','Arlington-ATTPark','Arlington-Downtown','Arlington-Uta','Arlington-Eastchase',
  'FortWorth-Downtown','FortWorth-West7th','FortWorth-Stockyards','FortWorth-TCU','FortWorth-CampBowie',
  'Grapevine-MainSt','Southlake-TownSquare','Keller-TownCenter','NorthRichlandHills','Hurst-Euless-Bedford',
  'Mesquite-TownEast','Rockwall-Harbor','Rowlett','Coppell','FlowerMound','Denton-Downtown','Denton-North',
  'Prosper','Celina','LittleElm','Prosper-Gates','Frisco-PantherCreek','Plano-ParkBlvd','Allen-TwinCreeks',
  'Wylie','Sachse','Murphy','FarmersBranch','HighlandPark','UniversityPark','LakeHighlands','WhiteRockLake',
  'CedarHill','DeSoto','Duncanville','Mansfield','Burleson','Weatherford','Aledo','Azle','Roanoke','Haslet',
  'Keller-North','Saginaw','Benbrook','HaltomCity','Colleyville','Euless','Bedford','Hurst','TrophyClub',
  'Argyle','Justin','Corinth','HighlandVillage','Cleburne','Ennis','Waxahachie','Midlothian','Forney','Terrell',
  'Seagoville','Lancaster','RedOak','Ovilla','Sunnyvale','BalchSprings','Mesquite-East','Rowlett-Bayside'
];

function expandTo150(list) {
  const out = [];
  let i = 1;
  while (out.length < 150) {
    const base = list[out.length % list.length];
    const sector = String(Math.ceil(i / 3)).padStart(2, '0');
    out.push(base + '-' + sector);
    i++;
  }
  return out;
}

const AREAS = expandTo150(BASE_LOCATIONS);

function clamp(n, min, max){ return Math.max(min, Math.min(max, n)); }
function rnd(norm=0, spread=1){
  let u=0, v=0; while(!u) u=Math.random(); while(!v) v=Math.random();
  const z=Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);
  return norm+z*spread;
}
function mkNow(){ return new Date(); }

function genRow(area){
  // --- Randomize realistic network + behavioral data ---
  const latencyMs = clamp(Math.round(rnd(55,30)),10,250);
  const packetLoss = clamp(Math.abs(rnd(0.8,0.7)),0,5);
  const serviceOk = Math.random()<0.95?1:0;
  const networkLoad = clamp(Math.round(rnd(55,25)),5,100);
  const sessions = clamp(Math.round(rnd(8000,6000)),500,60000);

  const latencyScore = clamp(100-((latencyMs-20)*0.8),0,100);
  const packetLossScore = clamp(100-(packetLoss*20),0,100);
  const surveyScore = clamp(Math.round(rnd(3.5,1)*100)/100,1,5);
  const reviewScore = clamp(Math.round(rnd(3.5,1)*100)/100,1,5);
  const retentionScore = clamp(Math.round((latencyScore*0.3+packetLossScore*0.2+surveyScore*12+reviewScore*8+(serviceOk?10:-20))),0,100);
  const remainMonths = clamp(Math.round((retentionScore/100)*36*10)/10,1,48);

  const avgIncome = clamp(Math.round(rnd(80000,40000)),35000,180000);
  const sales = clamp(Math.round(rnd(100000,80000)),5000,350000);
  const businessIndex = clamp(Math.round(((sales/avgIncome)*15+retentionScore*0.4)),0,100);

  const brandMarketScore = clamp(Math.round(rnd(50,30)),0,100);
  const adReach = clamp(Math.round(rnd(150000,90000)),5000,1000000);
  const shares = clamp(Math.round(rnd(100,80)),0,2000);
  const likes = clamp(Math.round(rnd(1000,800)),0,15000);
  const posts = clamp(Math.round(rnd(60,30)),0,1000);
  const comments = clamp(Math.round(rnd(300,200)),0,8000);

  return { ts:mkNow(), market_id:area, latencyMs, packetLoss, serviceOk, networkLoad, sessions,
           latencyScore, packetLossScore, surveyScore, reviewScore,
           retentionScore, remainMonths, avgIncome, sales, businessIndex,
           brandMarketScore, adReach, shares, likes, posts, comments };
}

async function insertBatch(table, columns, rows){
  if(rows.length===0) return;
  const values=[]; const params=[];
  rows.forEach((r,i)=>{
    const start=i*columns.length;
    params.push('(' + columns.map((_,j)=>'$'+(start+j+1)).join(',') + ')');
    columns.forEach(c=>values.push(r[c]));
  });
  const sql=`INSERT INTO ${table} (${columns.join(',')}) VALUES ${params.join(',')}`;
  await pool.query(sql, values);
}

async function tick(){
  const rows = AREAS.map(genRow);
  await insertBatch('network_metrics',
    ['ts','market_id','network_load_percent','avg_latency_ms','packet_loss_ratio','active_sessions'],
    rows.map(r=>({ts:r.ts,market_id:r.market_id,network_load_percent:r.networkLoad,avg_latency_ms:r.latencyMs,packet_loss_ratio:r.packetLoss,active_sessions:r.sessions}))
  );
  console.log(`Inserted ${rows.length} rows at ${new Date().toLocaleTimeString()}`);
}

async function main(){
  console.log('🔁 Generating live data for', AREAS.length, 'markets every 1 minute');
  await tick(); // initial
  cron.schedule('* * * * *', async ()=>{
    try{ await tick(); } catch(e){ console.error('tick error', e.message); }
  });
}
main().catch(e=>{ console.error(e); process.exit(1); });
