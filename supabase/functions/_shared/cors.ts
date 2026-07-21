export const CORS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Headers': 'authorization, content-type',
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export const JSON_CORS = { 'Content-Type': 'application/json', ...CORS };
