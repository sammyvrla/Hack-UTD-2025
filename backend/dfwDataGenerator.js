// Generate synthetic metrics across 150 DFW coverage areas and insert into Postgres
import dotenv from 'dotenv';
import pool from './db/db.js';

dotenv.config();

// A base list of known DFW areas; we'll expand with numbered sectors to reach 150
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
    const sector = String(Math.ceil(i/3)).padStart(2, '0');
    out.push(base + '-' + sector);
    i++;
  }
  return out;
}

const AREAS = expandTo150(BASE_LOCATIONS);

function clamp(n, min, max){ return Math.max(min, Math.min(max, n)); }
function rnd(norm=0, spread=1) { // gaussian-ish using Box–Muller
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  return norm + z * spread;
}

function mkNow(){ return new Date(); }

function genRow(area){
  // Network raw
  const latencyMs = clamp(Math.round(rnd(55, 20)), 15, 180);
  const packetLoss = clamp(Math.abs(rnd(0.4, 0.35)), 0, 3.5); // %
  const serviceOk = Math.random() < 0.97 ? 1 : 0; // ~3% outages
  const networkLoad = clamp(Math.round(rnd(60, 20)), 10, 99);
  const sessions = clamp(Math.round(rnd(8000, 6000)), 500, 60000);

  // Scores (0-100 higher is better)
  const latencyScore = clamp(100 - ((latencyMs - 20) * 0.7), 0, 100);
  const packetLossScore = clamp(100 - (packetLoss * 20), 0, 100);

  // Sentiment 1-5
  const surveyScore = clamp(Math.round((rnd(3.9, 0.6))*100)/100, 1, 5);
  const reviewScore = clamp(Math.round((rnd(3.8, 0.5))*100)/100, 1, 5);

  // Engagement
  const retentionScore = clamp(Math.round((latencyScore*0.3 + packetLossScore*0.2 + surveyScore*12 + reviewScore*8 + (serviceOk?10:-20)) ), 0, 100);
  const remainMonths = clamp(Math.round((retentionScore/100)*36*10)/10, 1, 48);

  // Market context
  const avgIncome = clamp(Math.round(rnd(85000, 25000)), 35000, 180000);
  const sales = clamp(Math.round(rnd(120000, 60000)), 10000, 350000);
  const businessIndex = clamp(Math.round(((sales/avgIncome)*18 + retentionScore*0.3)), 0, 100);

  // Brand & social
  const brandMarketScore = clamp(Math.round((rnd(68, 12))), 20, 100);
  const adReach = clamp(Math.round(rnd(180000, 75000)), 10000, 1000000);
  const shares = clamp(Math.round(rnd(120, 60)), 0, 1200);
  const likes = clamp(Math.round(rnd(1400, 700)), 0, 15000);
  const posts = clamp(Math.round(rnd(65, 25)), 0, 800);
  const comments = clamp(Math.round(rnd(320, 140)), 0, 6000);

  return {
    ts: mkNow(), market_id: area,
    latencyMs, packetLoss, serviceOk, networkLoad, sessions,
    latencyScore, packetLossScore,
    surveyScore, reviewScore,
    retentionScore, remainMonths,
    avgIncome, sales, businessIndex,
    brandMarketScore, adReach,
    shares, likes, posts, comments
  };
}

async function insertBatch(table, columns, rows) {
  if (rows.length === 0) return;
  const values = [];
  const params = [];
  rows.forEach((r, i) => {
    const start = i*columns.length;
    params.push('(' + columns.map((_, j)=>'$'+(start+j+1)).join(',') + ')');
    columns.forEach(c => values.push(r[c]));
  });
  const sql = `INSERT INTO ${table} (${columns.join(',')}) VALUES ${params.join(',')}`;
  await pool.query(sql, values);
}

async function tick(){
  const rows = AREAS.map(genRow);
  // Raw network table already exists
  await insertBatch('network_metrics',
    ['ts','market_id','network_load_percent','avg_latency_ms','packet_loss_ratio','active_sessions'],
    rows.map(r=>({ ts:r.ts, market_id:r.market_id, network_load_percent:r.networkLoad, avg_latency_ms:r.latencyMs, packet_loss_ratio:r.packetLoss, active_sessions:r.sessions }))
  );
  await insertBatch('network_health',
    ['ts','market_id','latency_score','packet_loss_score','service_ok'],
    rows.map(r=>({ ts:r.ts, market_id:r.market_id, latency_score:r.latencyScore, packet_loss_score:r.packetLossScore, service_ok:r.serviceOk }))
  );
  await insertBatch('sentiment_scores',
    ['ts','market_id','survey_score','review_score'],
    rows.map(r=>({ ts:r.ts, market_id:r.market_id, survey_score:r.surveyScore, review_score:r.reviewScore }))
  );
  await insertBatch('engagement_metrics',
    ['ts','market_id','retention_score','likely_remain_months'],
    rows.map(r=>({ ts:r.ts, market_id:r.market_id, retention_score:r.retentionScore, likely_remain_months:r.remainMonths }))
  );
  await insertBatch('market_context',
    ['ts','market_id','avg_income_usd','sales_usd','business_index'],
    rows.map(r=>({ ts:r.ts, market_id:r.market_id, avg_income_usd:r.avgIncome, sales_usd:r.sales, business_index:r.businessIndex }))
  );
  await insertBatch('brand_market',
    ['ts','market_id','brand_market_score','ad_reach'],
    rows.map(r=>({ ts:r.ts, market_id:r.market_id, brand_market_score:r.brandMarketScore, ad_reach:r.adReach }))
  );
  await insertBatch('social_metrics',
    ['ts','market_id','shares','likes','posts','comments'],
    rows.map(r=>({ ts:r.ts, market_id:r.market_id, shares:r.shares, likes:r.likes, posts:r.posts, comments:r.comments }))
  );

  // Combined table for simplified analytics
  await insertBatch('coverage_metrics',
    ['ts','market_id','latency_score','packet_loss_score','outage_flag','survey_score','review_score','consumer_retention_score','likely_remain_months','avg_income_usd','sales_usd','business_index','brand_market_score','ad_reach','shares','likes','posts','comments'],
    rows.map(r=>({ ts:r.ts, market_id:r.market_id, latency_score:r.latencyScore, packet_loss_score:r.packetLossScore, outage_flag:r.serviceOk, survey_score:r.surveyScore, review_score:r.reviewScore, consumer_retention_score:r.retentionScore, likely_remain_months:r.remainMonths, avg_income_usd:r.avgIncome, sales_usd:r.sales, business_index:r.businessIndex, brand_market_score:r.brandMarketScore, ad_reach:r.adReach, shares:r.shares, likes:r.likes, posts:r.posts, comments:r.comments }))
  );
}

async function main(){
  const mode = process.env.GEN_MODE || 'interval'; // 'once' | 'interval'
  const everyMs = parseInt(process.env.GEN_EVERY_MS || '10000', 10);
  if (mode === 'once'){
    await tick();
    console.log('Generated one batch for', AREAS.length, 'areas');
    process.exit(0);
  } else {
    console.log('Generating data for', AREAS.length, 'DFW areas every', everyMs,'ms');
    // First tick immediately, then setInterval
    await tick();
    setInterval(async ()=>{
      try{ await tick(); } catch(e){ console.error('tick error', e.message); }
    }, everyMs);
  }
}

main().catch(e=>{ console.error(e); process.exit(1); });
