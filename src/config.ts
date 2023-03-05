export const LOCAL_DOMAIN = Deno.env.get('LOCAL_DOMAIN') || 'http://localhost:8000';
export const POST_CHAR_LIMIT = Number(Deno.env.get('POST_CHAR_LIMIT') || 5000);