// Standard HTTP response helpers for Worker HTTP endpoints

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

export function unauthorizedResponse(): Response {
  return errorResponse('Unauthorized', 401);
}

export function notFoundResponse(): Response {
  return errorResponse('Not found', 404);
}

export function methodNotAllowedResponse(): Response {
  return errorResponse('Method not allowed', 405);
}

export function validateApiKey(request: Request, expectedKey: string): boolean {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return false;
  const [scheme, key] = authHeader.split(' ');
  return scheme === 'Bearer' && key === expectedKey;
}
