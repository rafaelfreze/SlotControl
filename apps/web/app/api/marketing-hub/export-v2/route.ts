import {postPlatformEpochExport} from '@/lib/marketing-hub/epoch';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function POST(request:Request){try{return await postPlatformEpochExport(request);}catch{return Response.json({error:'measurement_source_unavailable'},{status:503,headers:{'Cache-Control':'private, no-store'}});}}
