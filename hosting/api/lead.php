<?php
// Same-origin relay for the lead form on kadastrhelp.ru (reg.ru hosting).
//
// Visitors whose provider blocks *.up.railway.app can still reach the
// domain the page came from; this script passes the lead on to server.js
// on Railway server-to-server. It sends nothing to Telegram itself and
// holds no bot token — validation, rate limits and delivery stay in
// server.js.
//
// The shared secret lives OUTSIDE the web root, in ~/lead-relay.secret
// (this file is ~/www/kadastrhelp.ru/api/lead.php). With it, server.js
// rate-limits by the visitor's IP; without it every lead would count
// against the hosting server's single IP.

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function relay_fail($code, $reason) {
    http_response_code($code);
    echo json_encode(array('ok' => false, 'reason' => $reason));
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST');
    relay_fail(405, 'method_not_allowed');
}

// Same cap as LEAD_MAX_BODY_BYTES in server.js.
$max = 8 * 1024;
$body = file_get_contents('php://input', false, null, 0, $max + 1);
if ($body === false || $body === '') relay_fail(400, 'invalid_json');
if (strlen($body) > $max) relay_fail(400, 'too_large');

$headers = array(
    'Content-Type: application/json',
    'Origin: https://kadastrhelp.ru',
);
$secretFile = dirname(__DIR__, 3) . '/lead-relay.secret';
$secret = is_readable($secretFile) ? trim((string) file_get_contents($secretFile)) : '';
$clientIp = $_SERVER['REMOTE_ADDR'] ?? '';
if ($secret !== '' && preg_match('/^[0-9a-fA-F:.]{2,45}$/', $clientIp)) {
    $headers[] = 'X-Lead-Relay: ' . $secret;
    $headers[] = 'X-Lead-Client-IP: ' . $clientIp;
}

// LEAD_RELAY_UPSTREAM is for local tests only; the hosting never sets it.
$upstream = getenv('LEAD_RELAY_UPSTREAM') ?: 'https://bti-samara-landing-production.up.railway.app/api/lead';
$ch = curl_init($upstream);
curl_setopt_array($ch, array(
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => $body,
    CURLOPT_HTTPHEADER => $headers,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_CONNECTTIMEOUT => 4,
    CURLOPT_TIMEOUT => 8,
    CURLOPT_FOLLOWLOCATION => false,
));
$resp = curl_exec($ch);
$code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
// Non-zero once DNS, TCP and TLS are done and the request is about to go out.
$started = curl_getinfo($ch, CURLINFO_PRETRANSFER_TIME) > 0;
curl_close($ch);

if ($resp === false || $code === 0) {
    // The request went out but no answer came back: server.js may already
    // have sent the lead, so the page must not retry it elsewhere. Failing
    // before that (DNS, connect, TLS) means nothing reached server.js and
    // the page tries Railway directly.
    if ($started) relay_fail(504, 'upstream_timeout');
    relay_fail(502, 'upstream_unreachable');
}

http_response_code($code);
echo $resp;
