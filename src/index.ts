import { DbConnection, SubscriptionBuilder, type EventContext, type ReducerEventContext, type SubscriptionEventContext, type ErrorContext } from './module_bindings';
import { Identity } from 'spacetimedb';

// ============================================================
// Constants
// ============================================================
const TILE_SIZE = 32;
const CHUNK_SIZE = 16;
const COLORS: Record<string, string> = {
  grass: '#4a7c3f', dirt: '#8b7355', stone: '#808080', water: '#3a6ea5',
};

// ============================================================
// State
// ============================================================
let conn: DbConnection | null = null;
let myIdentity: Identity | null = null;
let myToken: string | null = null;
let playing = false;
let myAgentCache: any = null; // Cache agent from onInsert
let selectedSlot = 0; // 0 = bare hands, 1-8 = inventory slots
let chatOpen = false;
let chatText = '';
let useMode = false; // F pressed, waiting for direction
let lastActionTime = 0;
let showItemLabels = false; // Toggle with L key
const CLIENT_COOLDOWN = 200; // ms, throttle actions client-side

// Visual feedback for actions
type ActionEffect = { type: 'success' | 'failed'; x: number; y: number; time: number } | null;
let actionEffect: ActionEffect = null;
const ACTION_EFFECT_DURATION = 400; // ms

// Camera
let camX = 0, camY = 0;
let zoom = 1;
let dragging = false;
let dragStartX = 0, dragStartY = 0;
let camStartX = 0, camStartY = 0;

// Canvas
const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx2d = canvas.getContext('2d')!;
const chatInput = document.getElementById('chat-input') as HTMLInputElement;
const chatBox = document.getElementById('chat-box') as HTMLDivElement;
const hud = document.getElementById('hud') as HTMLDivElement;
const playBtn = document.getElementById('play-btn') as HTMLButtonElement;
const leaderboardDiv = document.getElementById('leaderboard') as HTMLDivElement;

// Messages with timestamps for fading
const floatingMessages: { text: string; name: string; x: number; y: number; time: number }[] = [];

// Track loaded chunks
const loadedChunks = new Set<string>();

// ============================================================
// Tag helpers (client side)
// ============================================================
function parseTags(tags: string): Map<string, string | number | true> {
  const map = new Map<string, string | number | true>();
  if (!tags) return map;
  for (const token of tags.split(',')) {
    if (!token) continue;
    const idx = token.indexOf(':');
    if (idx === -1) { map.set(token, true); continue; }
    const key = token.substring(0, idx);
    const valStr = token.substring(idx + 1);
    const num = parseFloat(valStr);
    if (!isNaN(num) && isFinite(num)) map.set(key, num);
    else map.set(token, true);
  }
  return map;
}
function getTag(tags: string, key: string): number {
  const m = parseTags(tags);
  const v = m.get(key);
  return typeof v === 'number' ? v : 0;
}
function hasTag(tags: string, t: string): boolean { return parseTags(tags).has(t); }

// ============================================================
// Connection
// ============================================================

// Server URL: use ?server=local for localhost, otherwise maincloud
function getServerUri(): string {
  const params = new URLSearchParams(window.location.search);
  if (params.get('server') === 'local') {
    return 'ws://localhost:3000';
  }
  return 'wss://maincloud.spacetimedb.com';
}

function connect() {
  const savedToken = localStorage.getItem('clawworld_token') || undefined;
  const serverUri = getServerUri();
  console.log('Connecting to:', serverUri);
  conn = DbConnection.builder()
    .withUri(serverUri)
    .withModuleName('clawworld')
    .withToken(savedToken)
    .onConnect((_conn, identity, token) => {
      myIdentity = identity;
      myToken = token;
      localStorage.setItem('clawworld_token', token);
      console.log('Connected as', identity.toHexString());
      setupCallbacks();

      // Subscribe to views (per-client filtered data) + leaderboard (public)
      _conn.subscriptionBuilder()
        .onApplied(() => {
          console.log('Subscribed to views');
          // Hide loading screen
          const loadingScreen = document.getElementById('loading-screen');
          if (loadingScreen) loadingScreen.style.display = 'none';

          // Check for existing agent via my_agent view
          let foundAgent = false;
          for (const a of _conn.db.myAgent.iter()) {
            if (a) {
              myAgentCache = a;
              playing = true;
              playBtn.style.display = 'none';
              foundAgent = true;
              // Show quit button and controls for returning players
              const quitBtn = document.getElementById('quit-btn');
              if (quitBtn) quitBtn.style.display = 'block';
              const controlsHelp = document.getElementById('controls-help');
              if (controlsHelp) controlsHelp.style.display = 'block';
              console.log('Found existing agent:', a.name);
              break;
            }
          }

          // Show welcome modal only if no existing agent
          if (!foundAgent) {
            const modal = document.getElementById('welcome-modal');
            if (modal) modal.style.display = 'flex';
          }

          render();
        })
        .subscribe([
          'SELECT * FROM my_agent',
          'SELECT * FROM nearby_tiles',
          'SELECT * FROM nearby_items',
          'SELECT * FROM nearby_agents',
          'SELECT * FROM nearby_messages',
          'SELECT * FROM leaderboard'
        ]);
    })
    .onDisconnect(() => { console.log('Disconnected'); })
    .onConnectError((e) => {
      console.error('Connect error:', e);
      // Auto-clear stale token on connection failure
      // This handles cases where the server was restarted with a fresh database
      if (savedToken) {
        console.log('Connection failed with saved token, clearing token and retrying...');
        localStorage.removeItem('clawworld_token');
        // Retry connection without the stale token
        setTimeout(() => connect(), 1000);
      }
    })
    .build();
}

// ============================================================
// Get my agent
// ============================================================
function getMyAgent() {
  // Use cache from onInsert/onUpdate callbacks
  return myAgentCache;
}

// ============================================================
// Inventory
// ============================================================
function getInventory() {
  if (!conn || !myIdentity) return [];
  const items: any[] = [];
  // nearby_items includes our carried items (they're at our position)
  for (const item of conn.db.nearbyItems.iter()) {
    if (item.carrier && item.carrier.isEqual?.(myIdentity)) items.push(item);
  }
  return items;
}

// ============================================================
// Chunk loading
// ============================================================
function ensureChunksLoaded(centerX: number, centerY: number) {
  if (!conn) return;
  const cx = Math.floor(centerX / CHUNK_SIZE);
  const cy = Math.floor(centerY / CHUNK_SIZE);
  // Load 9x9 chunks (radius 4) to ensure world is always visible when zoomed out
  const radius = 4;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const key = `${cx + dx},${cy + dy}`;
      if (!loadedChunks.has(key)) {
        loadedChunks.add(key);
        conn.reducers.generateChunk({ chunkX: cx + dx, chunkY: cy + dy });
      }
    }
  }
}

// ============================================================
// Rendering
// ============================================================
function render() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  ctx2d.clearRect(0, 0, canvas.width, canvas.height);

  if (!conn) return;

  // Poll my_agent view (fallback for view callback issues)
  checkMyAgentFromView();

  const agent = getMyAgent();
  if (agent && playing) {
    camX = agent.x * TILE_SIZE + TILE_SIZE / 2;
    camY = agent.y * TILE_SIZE + TILE_SIZE / 2;
    ensureChunksLoaded(agent.x, agent.y);
  } else {
    // Not playing or no agent - show world around origin (0,0)
    // This makes the welcome screen show world activity in the background
    camX = 0;
    camY = 0;
    ensureChunksLoaded(0, 0);
  }

  ctx2d.save();
  ctx2d.translate(canvas.width / 2, canvas.height / 2);
  ctx2d.scale(zoom, zoom);
  ctx2d.translate(-camX, -camY);

  // Visible bounds
  const halfW = canvas.width / 2 / zoom;
  const halfH = canvas.height / 2 / zoom;
  const minTX = Math.floor((camX - halfW) / TILE_SIZE) - 1;
  const maxTX = Math.ceil((camX + halfW) / TILE_SIZE) + 1;
  const minTY = Math.floor((camY - halfH) / TILE_SIZE) - 1;
  const maxTY = Math.ceil((camY + halfH) / TILE_SIZE) + 1;

  // Draw tiles from nearby_tiles view (visibility-filtered)
  for (const tile of conn.db.nearbyTiles.iter()) {
    if (tile.x < minTX || tile.x > maxTX || tile.y < minTY || tile.y > maxTY) continue;
    const tags = parseTags(tile.tags);
    let color = '#333';
    if (tags.has('surface:grass')) color = COLORS.grass;
    else if (tags.has('surface:dirt')) color = COLORS.dirt;
    else if (tags.has('surface:stone')) color = COLORS.stone;
    else if (tags.has('surface:water')) color = COLORS.water;

    ctx2d.fillStyle = color;
    ctx2d.fillRect(tile.x * TILE_SIZE, tile.y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
    ctx2d.strokeStyle = 'rgba(0,0,0,0.1)';
    ctx2d.strokeRect(tile.x * TILE_SIZE, tile.y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
  }

  // Draw fog of war (darken tiles outside visibility radius)
  if (agent && playing) {
    const VISIBILITY_RADIUS = 3;
    ctx2d.fillStyle = 'rgba(0, 0, 0, 0.7)';
    for (let ty = minTY; ty <= maxTY; ty++) {
      for (let tx = minTX; tx <= maxTX; tx++) {
        const dx = Math.abs(tx - agent.x);
        const dy = Math.abs(ty - agent.y);
        if (dx > VISIBILITY_RADIUS || dy > VISIBILITY_RADIUS) {
          ctx2d.fillRect(tx * TILE_SIZE, ty * TILE_SIZE, TILE_SIZE, TILE_SIZE);
        }
      }
    }
  }

  // Draw ground items from nearby_items view (grouped by position for stack offset)
  const groundItems: any[] = [];
  for (const item of conn.db.nearbyItems.iter()) {
    if (item.carrier) continue;
    if (item.x < minTX || item.x > maxTX || item.y < minTY || item.y > maxTY) continue;
    groundItems.push(item);
  }

  // Group items by position
  const itemStacks = new Map<string, any[]>();
  for (const item of groundItems) {
    const key = `${item.x},${item.y}`;
    if (!itemStacks.has(key)) itemStacks.set(key, []);
    itemStacks.get(key)!.push(item);
  }

  // Sort each stack by ID (lower ID = bottom of stack, drawn first)
  for (const [_, stack] of itemStacks) {
    stack.sort((a, b) => Number(a.id) - Number(b.id));
  }

  // Draw stacks with offset
  for (const [_, stack] of itemStacks) {
    for (let i = 0; i < stack.length; i++) {
      drawItem(stack[i], i, stack.length);
    }
  }

  // Draw my agent from my_agent view
  for (const a of conn.db.myAgent.iter()) {
    if (a && a.x >= minTX && a.x <= maxTX && a.y >= minTY && a.y <= maxTY) {
      drawAgent(a);
    }
  }

  // Draw nearby agents from nearby_agents view
  for (const a of conn.db.nearbyAgents.iter()) {
    if (a.x < minTX || a.x > maxTX || a.y < minTY || a.y > maxTY) continue;
    drawAgent(a);
  }

  // Draw floating messages
  const now = Date.now();
  for (let i = floatingMessages.length - 1; i >= 0; i--) {
    const msg = floatingMessages[i];
    const age = now - msg.time;
    if (age > 5000) { floatingMessages.splice(i, 1); continue; }
    const alpha = Math.max(0, 1 - age / 5000);
    ctx2d.globalAlpha = alpha;
    ctx2d.fillStyle = 'white';
    ctx2d.strokeStyle = 'black';
    ctx2d.lineWidth = 2;
    ctx2d.font = '12px monospace';
    ctx2d.textAlign = 'center';
    const tx = msg.x * TILE_SIZE + TILE_SIZE / 2;
    const ty = msg.y * TILE_SIZE - 8 - (age / 5000) * 20;
    ctx2d.strokeText(msg.text, tx, ty);
    ctx2d.fillText(msg.text, tx, ty);
    ctx2d.globalAlpha = 1;
  }

  ctx2d.restore();

  // HUD
  drawHUD();
  drawLeaderboard();

  requestAnimationFrame(render);
}

function drawItem(item: any, stackIndex: number = 0, stackSize: number = 1) {
  // Stack offset: each item in stack is offset slightly up-left
  // Bottom item (index 0) is at base, top item (highest index) is offset most
  const stackOffset = 2; // pixels per stack level
  const offsetX = stackIndex * stackOffset;
  const offsetY = -stackIndex * stackOffset; // negative = up

  const cx = item.x * TILE_SIZE + TILE_SIZE / 2 + offsetX;
  const cy = item.y * TILE_SIZE + TILE_SIZE / 2 + offsetY;
  const tags = parseTags(item.tags);

  if (tags.has('name:tree')) {
    // Dark green circle
    ctx2d.fillStyle = '#2d5a1e';
    ctx2d.beginPath();
    ctx2d.arc(cx, cy - 4, 10, 0, Math.PI * 2);
    ctx2d.fill();
    ctx2d.fillStyle = '#5c3a1e';
    ctx2d.fillRect(cx - 2, cy + 2, 4, 10);
  } else if (tags.has('name:berry_bush')) {
    ctx2d.fillStyle = '#3a8a2e';
    ctx2d.beginPath();
    ctx2d.arc(cx, cy, 8, 0, Math.PI * 2);
    ctx2d.fill();
    if (tags.has('harvestable')) {
      // Red dots
      for (const [ox, oy] of [[-3,-3],[3,-2],[0,3],[4,1]]) {
        ctx2d.fillStyle = '#cc2222';
        ctx2d.beginPath();
        ctx2d.arc(cx + ox, cy + oy, 2, 0, Math.PI * 2);
        ctx2d.fill();
      }
    }
  } else if (tags.has('name:sword')) {
    ctx2d.fillStyle = '#c0c0c0';
    ctx2d.fillRect(cx - 1, cy - 8, 3, 16);
    ctx2d.fillStyle = '#8b6914';
    ctx2d.fillRect(cx - 4, cy + 4, 9, 3);
  } else if (tags.has('name:axe')) {
    ctx2d.fillStyle = '#8b6914';
    ctx2d.fillRect(cx - 1, cy - 6, 3, 14);
    ctx2d.fillStyle = '#808080';
    ctx2d.fillRect(cx + 2, cy - 6, 6, 8);
  } else if (tags.has('name:berries')) {
    ctx2d.fillStyle = '#cc2222';
    ctx2d.beginPath();
    ctx2d.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx2d.fill();
  } else if (tags.has('name:wood')) {
    ctx2d.fillStyle = '#8b6914';
    ctx2d.fillRect(cx - 6, cy - 2, 12, 5);
  } else if (tags.has('name:pickaxe')) {
    // Pickaxe: brown handle + gray head
    ctx2d.fillStyle = '#8b6914';
    ctx2d.fillRect(cx - 1, cy - 6, 3, 14);
    ctx2d.fillStyle = '#606060';
    ctx2d.beginPath();
    ctx2d.moveTo(cx - 6, cy - 6);
    ctx2d.lineTo(cx + 6, cy - 6);
    ctx2d.lineTo(cx + 4, cy - 2);
    ctx2d.lineTo(cx - 4, cy - 2);
    ctx2d.closePath();
    ctx2d.fill();
  } else if (tags.has('name:flint_steel')) {
    // Flint + steel: gray flint + dark metal
    ctx2d.fillStyle = '#505050';
    ctx2d.fillRect(cx - 5, cy - 2, 6, 5);
    ctx2d.fillStyle = '#333';
    ctx2d.fillRect(cx + 1, cy - 3, 4, 7);
  } else if (tags.has('name:bandage')) {
    // Bandage: white roll with red cross
    ctx2d.fillStyle = '#f0f0f0';
    ctx2d.fillRect(cx - 5, cy - 4, 10, 8);
    ctx2d.fillStyle = '#cc2222';
    ctx2d.fillRect(cx - 1, cy - 3, 2, 6);
    ctx2d.fillRect(cx - 3, cy - 1, 6, 2);
  } else if (tags.has('name:torch')) {
    // Torch: brown stick, optionally with flame
    ctx2d.fillStyle = '#6b4423';
    ctx2d.fillRect(cx - 2, cy - 2, 4, 10);
    if (tags.has('lit')) {
      // Flame
      ctx2d.fillStyle = '#ff6600';
      ctx2d.beginPath();
      ctx2d.moveTo(cx, cy - 8);
      ctx2d.lineTo(cx - 4, cy - 2);
      ctx2d.lineTo(cx + 4, cy - 2);
      ctx2d.closePath();
      ctx2d.fill();
      ctx2d.fillStyle = '#ffcc00';
      ctx2d.beginPath();
      ctx2d.arc(cx, cy - 4, 3, 0, Math.PI * 2);
      ctx2d.fill();
    }
  } else if (tags.has('name:poison_mushroom')) {
    // Poison mushroom: purple cap with white spots
    ctx2d.fillStyle = '#6a0dad';
    ctx2d.beginPath();
    ctx2d.arc(cx, cy - 2, 7, Math.PI, 0);
    ctx2d.fill();
    ctx2d.fillStyle = '#e0e0e0';
    ctx2d.fillRect(cx - 2, cy - 2, 4, 8);
    // White spots
    ctx2d.fillStyle = 'white';
    ctx2d.beginPath(); ctx2d.arc(cx - 3, cy - 5, 1.5, 0, Math.PI * 2); ctx2d.fill();
    ctx2d.beginPath(); ctx2d.arc(cx + 2, cy - 4, 1.5, 0, Math.PI * 2); ctx2d.fill();
  } else if (tags.has('name:rock')) {
    // Rock: large gray boulder
    ctx2d.fillStyle = '#707070';
    ctx2d.beginPath();
    ctx2d.ellipse(cx, cy, 10, 8, 0, 0, Math.PI * 2);
    ctx2d.fill();
    ctx2d.fillStyle = '#505050';
    ctx2d.beginPath();
    ctx2d.ellipse(cx + 2, cy + 2, 6, 4, 0.3, 0, Math.PI * 2);
    ctx2d.fill();
  } else if (tags.has('name:stone')) {
    // Stone (mined): small gray rock
    ctx2d.fillStyle = '#808080';
    ctx2d.beginPath();
    ctx2d.ellipse(cx, cy, 5, 4, 0, 0, Math.PI * 2);
    ctx2d.fill();
  } else if (tags.has('name:wall')) {
    // Wall: brick pattern
    ctx2d.fillStyle = '#8b4513';
    ctx2d.fillRect(cx - 10, cy - 10, 20, 20);
    ctx2d.strokeStyle = '#5a2d0a';
    ctx2d.lineWidth = 1;
    // Brick lines
    ctx2d.beginPath();
    ctx2d.moveTo(cx - 10, cy - 3); ctx2d.lineTo(cx + 10, cy - 3);
    ctx2d.moveTo(cx - 10, cy + 4); ctx2d.lineTo(cx + 10, cy + 4);
    ctx2d.moveTo(cx, cy - 10); ctx2d.lineTo(cx, cy - 3);
    ctx2d.moveTo(cx - 5, cy - 3); ctx2d.lineTo(cx - 5, cy + 4);
    ctx2d.moveTo(cx + 5, cy - 3); ctx2d.lineTo(cx + 5, cy + 4);
    ctx2d.moveTo(cx, cy + 4); ctx2d.lineTo(cx, cy + 10);
    ctx2d.stroke();
  } else if (tags.has('name:wall_kit')) {
    // Wall kit: small brick icon
    ctx2d.fillStyle = '#a0522d';
    ctx2d.fillRect(cx - 5, cy - 4, 10, 8);
    ctx2d.strokeStyle = '#5a2d0a';
    ctx2d.lineWidth = 1;
    ctx2d.strokeRect(cx - 5, cy - 4, 10, 8);
    ctx2d.beginPath();
    ctx2d.moveTo(cx - 5, cy); ctx2d.lineTo(cx + 5, cy);
    ctx2d.moveTo(cx, cy - 4); ctx2d.lineTo(cx, cy);
    ctx2d.stroke();
  } else if (tags.has('name:fire') || tags.has('burning')) {
    // Fire: animated flame
    ctx2d.fillStyle = '#ff4400';
    ctx2d.beginPath();
    ctx2d.moveTo(cx, cy - 10);
    ctx2d.quadraticCurveTo(cx - 8, cy, cx - 5, cy + 6);
    ctx2d.lineTo(cx + 5, cy + 6);
    ctx2d.quadraticCurveTo(cx + 8, cy, cx, cy - 10);
    ctx2d.fill();
    ctx2d.fillStyle = '#ffcc00';
    ctx2d.beginPath();
    ctx2d.moveTo(cx, cy - 5);
    ctx2d.quadraticCurveTo(cx - 4, cy + 2, cx - 2, cy + 4);
    ctx2d.lineTo(cx + 2, cy + 4);
    ctx2d.quadraticCurveTo(cx + 4, cy + 2, cx, cy - 5);
    ctx2d.fill();
  } else {
    ctx2d.fillStyle = '#ffff00';
    ctx2d.font = '10px monospace';
    ctx2d.fillText('?', cx - 3, cy + 3);
  }

  // Draw item label below (only for top item in stack, if enabled)
  if (showItemLabels && stackIndex === stackSize - 1) {
    const name = getItemNameFromTags(tags);
    if (name && name !== '?') {
      ctx2d.font = '7px monospace';
      ctx2d.textAlign = 'center';
      ctx2d.fillStyle = 'rgba(255,255,255,0.9)';
      ctx2d.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx2d.lineWidth = 2;
      // Position at bottom of tile, truncate if too long
      const displayName = name.length > 6 ? name.substring(0, 5) + '..' : name;
      const labelY = item.y * TILE_SIZE + TILE_SIZE - 2;
      ctx2d.strokeText(displayName, cx, labelY);
      ctx2d.fillText(displayName, cx, labelY);
    }
  }
}

// Extract item name from parsed tags
function getItemNameFromTags(tags: Map<string, string | number | true>): string {
  for (const [k] of tags) {
    if (k.startsWith('name:')) return k.substring(5);
  }
  return '?';
}

function drawAgent(a: any) {
  const cx = a.x * TILE_SIZE + TILE_SIZE / 2;
  const cy = a.y * TILE_SIZE + TILE_SIZE / 2;
  const isMe = myIdentity && a.identity?.isEqual?.(myIdentity);

  // Body (crab = small head up + two tail segments decreasing)
  ctx2d.fillStyle = isMe ? '#ff4444' : '#cc3333';
  // Tail segment 2 (smallest, back)
  ctx2d.beginPath();
  ctx2d.arc(cx, cy + 10, 3, 0, Math.PI * 2);
  ctx2d.fill();
  // Tail segment 1 (medium)
  ctx2d.beginPath();
  ctx2d.arc(cx, cy + 4, 5, 0, Math.PI * 2);
  ctx2d.fill();
  // Main body (head, smaller and higher)
  ctx2d.beginPath();
  ctx2d.arc(cx, cy - 4, 8, 0, Math.PI * 2);
  ctx2d.fill();
  // Outline for main body
  ctx2d.strokeStyle = isMe ? '#ffcc00' : '#000';
  ctx2d.lineWidth = isMe ? 2 : 1;
  ctx2d.beginPath();
  ctx2d.arc(cx, cy - 4, 8, 0, Math.PI * 2);
  ctx2d.stroke();

  // Eyes (on smaller raised head)
  ctx2d.fillStyle = 'white';
  ctx2d.beginPath(); ctx2d.arc(cx - 3, cy - 6, 2, 0, Math.PI * 2); ctx2d.fill();
  ctx2d.beginPath(); ctx2d.arc(cx + 3, cy - 6, 2, 0, Math.PI * 2); ctx2d.fill();
  ctx2d.fillStyle = 'black';
  ctx2d.beginPath(); ctx2d.arc(cx - 3, cy - 6, 0.8, 0, Math.PI * 2); ctx2d.fill();
  ctx2d.beginPath(); ctx2d.arc(cx + 3, cy - 6, 0.8, 0, Math.PI * 2); ctx2d.fill();

  // Claws (pincers) - attached to smaller head
  ctx2d.strokeStyle = isMe ? '#ff4444' : '#cc3333';
  ctx2d.lineWidth = 2;
  // Left arm (from head side outward)
  ctx2d.beginPath(); ctx2d.moveTo(cx - 7, cy - 4); ctx2d.lineTo(cx - 14, cy - 5); ctx2d.stroke();
  // Left pincer (from middle of arm going UP)
  ctx2d.beginPath(); ctx2d.moveTo(cx - 10, cy - 4); ctx2d.lineTo(cx - 14, cy - 11); ctx2d.stroke();
  // Right arm (from head side outward)
  ctx2d.beginPath(); ctx2d.moveTo(cx + 7, cy - 4); ctx2d.lineTo(cx + 14, cy - 5); ctx2d.stroke();
  // Right pincer (from middle of arm going UP)
  ctx2d.beginPath(); ctx2d.moveTo(cx + 10, cy - 4); ctx2d.lineTo(cx + 14, cy - 11); ctx2d.stroke();

  // Name
  ctx2d.fillStyle = 'white';
  ctx2d.strokeStyle = 'black';
  ctx2d.lineWidth = 2;
  ctx2d.font = 'bold 10px monospace';
  ctx2d.textAlign = 'center';
  ctx2d.strokeText(a.name, cx, cy - 16);
  ctx2d.fillText(a.name, cx, cy - 16);

  // HP bar
  const hp = getTag(a.tags, 'hp');
  const barW = 24;
  const barH = 3;
  const barX = cx - barW / 2;
  const barY = cy + 14;
  ctx2d.fillStyle = '#333';
  ctx2d.fillRect(barX, barY, barW, barH);
  ctx2d.fillStyle = hp > 50 ? '#22cc22' : hp > 25 ? '#cccc22' : '#cc2222';
  ctx2d.fillRect(barX, barY, barW * (hp / 100), barH);
}

function drawHUD() {
  const agent = getMyAgent();
  if (!agent || !playing) {
    // Show play button area
    if (!playing) {
      playBtn.style.display = 'block';
    }
    return;
  }
  playBtn.style.display = 'none';

  const hp = getTag(agent.tags, 'hp');
  const satiety = getTag(agent.tags, 'satiety');
  const inv = getInventory();

  let html = `<div class="stat">HP: <span class="bar"><span class="fill hp" style="width:${hp}%"></span></span> ${hp}</div>`;
  html += `<div class="stat">Satiety: <span class="bar"><span class="fill satiety" style="width:${satiety}%"></span></span> ${satiety}</div>`;
  html += `<div class="inventory">`;

  // Slot 0: Bare hands (same format as other slots: number + icon)
  const bareHandsSel = selectedSlot === 0 ? ' selected' : '';
  html += `<div class="slot${bareHandsSel}" onclick="window.__selectSlot(0)" title="Bare hands (punch/interact)">0<br>${getHandIcon()}</div>`;

  // Slots 1-8: Inventory
  for (let i = 0; i < 8; i++) {
    const item = inv[i];
    const sel = (i + 1) === selectedSlot ? ' selected' : '';
    const icon = item ? getItemIcon(item.tags) : '';
    const label = item ? getItemName(item.tags) : '';
    html += `<div class="slot${sel}" onclick="window.__selectSlot(${i + 1})" title="${label}">${i + 1}<br>${icon}</div>`;
  }
  html += `</div>`;

  // Selected item info
  if (selectedSlot === 0) {
    html += `<div style="margin-top:4px;color:#ffcc00;font-size:12px">Selected: <b>Bare hands</b> — <kbd>F</kbd> to punch/take</div>`;
  } else {
    const selItem = inv[selectedSlot - 1];
    if (selItem) {
      const name = getItemName(selItem.tags);
      html += `<div style="margin-top:4px;color:#ffcc00;font-size:12px">Selected: <b>${name}</b> — <kbd>F</kbd> to use, <kbd>Q</kbd> to drop</div>`;
      if (hasTag(selItem.tags, 'food')) {
        html += `<div style="color:#88ff88;font-size:11px">Press <kbd>F</kbd> then <kbd>Space</kbd> to eat</div>`;
      }
    }
  }

  if (useMode) html += `<div class="use-hint">USE: W/A/S/D=direction, F=here, Space=self (eat), Esc=cancel</div>`;

  // Cooldown indicator
  const cdRemaining = Math.max(0, 1000 - (Date.now() - lastActionTime));
  if (cdRemaining > 0) {
    const cdPct = (cdRemaining / 1000) * 100;
    html += `<div class="stat" style="margin-top:6px">Action: <span class="bar"><span class="fill" style="width:${cdPct}%;background:#cc4444"></span></span></div>`;
  } else {
    html += `<div class="stat" style="margin-top:6px;color:#66ff66">Action: READY</div>`;
  }

  hud.innerHTML = html;
  hud.style.display = 'block';
}

// Icon cache for HUD (data URLs)
const iconCache = new Map<string, string>();
const ICON_SIZE = 24;

function getItemIconDataUrl(tags: string): string {
  // Check cache first
  const cacheKey = tags;
  if (iconCache.has(cacheKey)) return iconCache.get(cacheKey)!;

  // Create offscreen canvas
  const offscreen = document.createElement('canvas');
  offscreen.width = ICON_SIZE;
  offscreen.height = ICON_SIZE;
  const octx = offscreen.getContext('2d')!;

  // Draw icon centered
  const cx = ICON_SIZE / 2;
  const cy = ICON_SIZE / 2;
  const scale = 0.8; // Scale down slightly to fit

  octx.save();
  octx.translate(cx, cy);
  octx.scale(scale, scale);
  octx.translate(-cx, -cy);

  drawItemIconAt(octx, cx, cy, tags);

  octx.restore();

  // Convert to data URL and cache
  const dataUrl = offscreen.toDataURL('image/png');
  iconCache.set(cacheKey, dataUrl);
  return dataUrl;
}

function drawItemIconAt(ctx: CanvasRenderingContext2D, cx: number, cy: number, tags: string) {
  const m = parseTags(tags);

  if (m.has('name:tree')) {
    ctx.fillStyle = '#2d5a1e';
    ctx.beginPath();
    ctx.arc(cx, cy - 4, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#5c3a1e';
    ctx.fillRect(cx - 2, cy + 2, 4, 10);
  } else if (m.has('name:berry_bush')) {
    ctx.fillStyle = '#3a8a2e';
    ctx.beginPath();
    ctx.arc(cx, cy, 8, 0, Math.PI * 2);
    ctx.fill();
    if (m.has('harvestable')) {
      for (const [ox, oy] of [[-3,-3],[3,-2],[0,3],[4,1]]) {
        ctx.fillStyle = '#cc2222';
        ctx.beginPath();
        ctx.arc(cx + ox, cy + oy, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  } else if (m.has('name:sword')) {
    ctx.fillStyle = '#c0c0c0';
    ctx.fillRect(cx - 1, cy - 8, 3, 16);
    ctx.fillStyle = '#8b6914';
    ctx.fillRect(cx - 4, cy + 4, 9, 3);
  } else if (m.has('name:axe')) {
    ctx.fillStyle = '#8b6914';
    ctx.fillRect(cx - 1, cy - 6, 3, 14);
    ctx.fillStyle = '#808080';
    ctx.fillRect(cx + 2, cy - 6, 6, 8);
  } else if (m.has('name:berries')) {
    ctx.fillStyle = '#cc2222';
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fill();
  } else if (m.has('name:wood')) {
    ctx.fillStyle = '#8b6914';
    ctx.fillRect(cx - 6, cy - 2, 12, 5);
  } else if (m.has('name:pickaxe')) {
    ctx.fillStyle = '#8b6914';
    ctx.fillRect(cx - 1, cy - 6, 3, 14);
    ctx.fillStyle = '#606060';
    ctx.beginPath();
    ctx.moveTo(cx - 6, cy - 6);
    ctx.lineTo(cx + 6, cy - 6);
    ctx.lineTo(cx + 4, cy - 2);
    ctx.lineTo(cx - 4, cy - 2);
    ctx.closePath();
    ctx.fill();
  } else if (m.has('name:flint_steel')) {
    ctx.fillStyle = '#505050';
    ctx.fillRect(cx - 5, cy - 2, 6, 5);
    ctx.fillStyle = '#333';
    ctx.fillRect(cx + 1, cy - 3, 4, 7);
  } else if (m.has('name:bandage')) {
    ctx.fillStyle = '#f0f0f0';
    ctx.fillRect(cx - 5, cy - 4, 10, 8);
    ctx.fillStyle = '#cc2222';
    ctx.fillRect(cx - 1, cy - 3, 2, 6);
    ctx.fillRect(cx - 3, cy - 1, 6, 2);
  } else if (m.has('name:torch')) {
    ctx.fillStyle = '#6b4423';
    ctx.fillRect(cx - 2, cy - 2, 4, 10);
    if (m.has('lit')) {
      ctx.fillStyle = '#ff6600';
      ctx.beginPath();
      ctx.moveTo(cx, cy - 8);
      ctx.lineTo(cx - 4, cy - 2);
      ctx.lineTo(cx + 4, cy - 2);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#ffcc00';
      ctx.beginPath();
      ctx.arc(cx, cy - 4, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (m.has('name:poison_mushroom')) {
    ctx.fillStyle = '#6a0dad';
    ctx.beginPath();
    ctx.arc(cx, cy - 2, 7, Math.PI, 0);
    ctx.fill();
    ctx.fillStyle = '#e0e0e0';
    ctx.fillRect(cx - 2, cy - 2, 4, 8);
    ctx.fillStyle = 'white';
    ctx.beginPath(); ctx.arc(cx - 3, cy - 5, 1.5, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + 2, cy - 4, 1.5, 0, Math.PI * 2); ctx.fill();
  } else if (m.has('name:rock')) {
    ctx.fillStyle = '#707070';
    ctx.beginPath();
    ctx.ellipse(cx, cy, 10, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#505050';
    ctx.beginPath();
    ctx.ellipse(cx + 2, cy + 2, 6, 4, 0.3, 0, Math.PI * 2);
    ctx.fill();
  } else if (m.has('name:stone')) {
    ctx.fillStyle = '#808080';
    ctx.beginPath();
    ctx.ellipse(cx, cy, 5, 4, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (m.has('name:wall')) {
    ctx.fillStyle = '#8b4513';
    ctx.fillRect(cx - 10, cy - 10, 20, 20);
    ctx.strokeStyle = '#5a2d0a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - 10, cy - 3); ctx.lineTo(cx + 10, cy - 3);
    ctx.moveTo(cx - 10, cy + 4); ctx.lineTo(cx + 10, cy + 4);
    ctx.moveTo(cx, cy - 10); ctx.lineTo(cx, cy - 3);
    ctx.moveTo(cx - 5, cy - 3); ctx.lineTo(cx - 5, cy + 4);
    ctx.moveTo(cx + 5, cy - 3); ctx.lineTo(cx + 5, cy + 4);
    ctx.moveTo(cx, cy + 4); ctx.lineTo(cx, cy + 10);
    ctx.stroke();
  } else if (m.has('name:wall_kit')) {
    ctx.fillStyle = '#a0522d';
    ctx.fillRect(cx - 5, cy - 4, 10, 8);
    ctx.strokeStyle = '#5a2d0a';
    ctx.lineWidth = 1;
    ctx.strokeRect(cx - 5, cy - 4, 10, 8);
    ctx.beginPath();
    ctx.moveTo(cx - 5, cy); ctx.lineTo(cx + 5, cy);
    ctx.moveTo(cx, cy - 4); ctx.lineTo(cx, cy);
    ctx.stroke();
  } else if (m.has('name:fire') || m.has('burning')) {
    ctx.fillStyle = '#ff4400';
    ctx.beginPath();
    ctx.moveTo(cx, cy - 10);
    ctx.quadraticCurveTo(cx - 8, cy, cx - 5, cy + 6);
    ctx.lineTo(cx + 5, cy + 6);
    ctx.quadraticCurveTo(cx + 8, cy, cx, cy - 10);
    ctx.fill();
    ctx.fillStyle = '#ffcc00';
    ctx.beginPath();
    ctx.moveTo(cx, cy - 5);
    ctx.quadraticCurveTo(cx - 4, cy + 2, cx - 2, cy + 4);
    ctx.lineTo(cx + 2, cy + 4);
    ctx.quadraticCurveTo(cx + 4, cy + 2, cx, cy - 5);
    ctx.fill();
  } else {
    ctx.fillStyle = '#ffff00';
    ctx.font = '12px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('?', cx, cy + 4);
  }
}

function getItemIcon(tags: string): string {
  // Return HTML img tag with canvas-rendered icon
  const dataUrl = getItemIconDataUrl(tags);
  return `<img src="${dataUrl}" width="${ICON_SIZE}" height="${ICON_SIZE}" style="vertical-align:middle">`;
}

// Hand icon for bare hands (open palm with fingers)
let handIconCache: string | null = null;
function getHandIcon(): string {
  if (handIconCache) return handIconCache;

  const offscreen = document.createElement('canvas');
  offscreen.width = ICON_SIZE;
  offscreen.height = ICON_SIZE;
  const octx = offscreen.getContext('2d')!;
  const cx = ICON_SIZE / 2;
  const cy = ICON_SIZE / 2 + 2;

  octx.fillStyle = '#e8c4a0'; // skin tone

  // Palm (rounded rectangle)
  octx.beginPath();
  octx.roundRect(cx - 5, cy - 2, 10, 10, 2);
  octx.fill();

  // Five fingers (vertical lines from palm)
  const fingerWidth = 2;
  const fingerSpacing = 2.5;
  const fingerLength = 6;
  for (let i = 0; i < 4; i++) {
    const fx = cx - 4 + i * fingerSpacing;
    octx.fillRect(fx, cy - 2 - fingerLength, fingerWidth, fingerLength);
  }

  // Thumb (angled to the side)
  octx.fillRect(cx - 7, cy + 1, 4, 3);

  handIconCache = `<img src="${offscreen.toDataURL('image/png')}" width="${ICON_SIZE}" height="${ICON_SIZE}" style="vertical-align:middle">`;
  return handIconCache;
}

function getItemName(tags: string): string {
  const m = parseTags(tags);
  for (const [k] of m) {
    if (k.startsWith('name:')) return k.substring(5);
  }
  return '?';
}

function drawLeaderboard() {
  if (!conn) return;

  // Build map of visible agents' born_at for current streak
  // (only agents in our visibility range - my_agent + nearby_agents)
  const aliveBornAt = new Map<string, number>();
  for (const a of conn.db.myAgent.iter()) {
    if (a) {
      const born = getTag(a.tags, 'born_at');
      if (born > 0) aliveBornAt.set(a.name, born);
    }
  }
  for (const a of conn.db.nearbyAgents.iter()) {
    const born = getTag(a.tags, 'born_at');
    if (born > 0) aliveBornAt.set(a.name, born);
  }

  const entries: any[] = [];
  for (const lb of conn.db.leaderboard.iter()) entries.push(lb);

  // Sort by current streak (alive) or best streak (dead)
  const nowMs = Date.now();
  const getStreak = (e: any) => {
    const born = aliveBornAt.get(e.name);
    if (born) return nowMs - born; // alive — current streak
    return Number(e.bestStreak); // dead — best streak
  };
  entries.sort((a, b) => getStreak(b) - getStreak(a));

  let html = '<h3>Leaderboard</h3>';
  for (const e of entries.slice(0, 10)) {
    const alive = aliveBornAt.has(e.name);
    const streak = Math.floor(getStreak(e) / 1000);
    const mins = Math.floor(streak / 60);
    const secs = streak % 60;
    const timeStr = mins > 0 ? `${mins}m${secs}s` : `${secs}s`;
    const prefix = alive ? '<span style="color:#22cc22">[A]</span>' : '<span style="color:#666">[X]</span>';
    html += `<div>${prefix} ${e.name}: ${timeStr} | K:${e.totalKills} D:${e.totalDeaths}</div>`;
  }
  leaderboardDiv.innerHTML = html;
}

// ============================================================
// Controls
// ============================================================
(window as any).__selectSlot = (i: number) => { selectedSlot = i; };
(window as any).__getConn = () => conn;
(window as any).__setPlaying = (v: boolean) => { playing = v; };
(window as any).__getState = () => {
  // Serialize agent to plain object for Puppeteer tests
  // SpacetimeDB objects with Identity/bigint don't serialize through page.evaluate
  const serializedAgent = myAgentCache ? {
    name: myAgentCache.name,
    x: myAgentCache.x,
    y: myAgentCache.y,
    tags: myAgentCache.tags,
    identity: myAgentCache.identity?.toHexString?.() ?? null,
  } : null;
  return {
    playing,
    myIdentity: myIdentity?.toHexString(),
    myAgent: serializedAgent,
    inventoryCount: getInventory().length,
  };
};

playBtn.addEventListener('click', () => {
  if (!conn) return;

  // Check if already have an agent
  const existingAgent = getMyAgent();
  if (existingAgent) {
    playing = true;
    playBtn.style.display = 'none';
    return;
  }

  const name = prompt('Enter name:');
  if (!name) return;

  conn.reducers.register({ name });
  playing = true;
  playBtn.style.display = 'none';
});

document.addEventListener('keydown', (e) => {
  if (chatOpen) {
    if (e.key === 'Enter') {
      if (chatText.trim() && conn) {
        conn.reducers.say({ text: chatText.trim() });
      }
      chatText = '';
      chatInput.value = '';
      chatInput.style.display = 'none';
      chatOpen = false;
    } else if (e.key === 'Escape') {
      chatText = '';
      chatInput.value = '';
      chatInput.style.display = 'none';
      chatOpen = false;
    }
    return;
  }

  if (!playing || !conn) return;
  if (e.repeat) return; // ignore key repeat

  // No client-side cooldown tracking — server-confirmed via onUpdate callback

  if (useMode) {
    let target = '';
    if (e.key === 'w' || e.key === 'W' || e.key === 'ArrowUp') target = 'north';
    else if (e.key === 's' || e.key === 'S' || e.key === 'ArrowDown') target = 'south';
    else if (e.key === 'a' || e.key === 'A' || e.key === 'ArrowLeft') target = 'west';
    else if (e.key === 'd' || e.key === 'D' || e.key === 'ArrowRight') target = 'east';
    else if (e.key === 'f' || e.key === 'F') target = 'here';
    else if (e.key === ' ') target = 'self';
    else if (e.key === 'Escape') { useMode = false; return; }

    if (target) {
      let itemId = 0n;
      if (selectedSlot > 0) {
        const inv = getInventory();
        const item = inv[selectedSlot - 1];
        itemId = item ? item.id : 0n;
      }
      conn.reducers.use({ itemId, target });
      useMode = false;
    }
    return;
  }

  // Movement
  if (e.key === 'w' || e.key === 'W' || e.key === 'ArrowUp') { conn.reducers.move({ direction: 'north' }); }
  else if (e.key === 's' || e.key === 'S' || e.key === 'ArrowDown') { conn.reducers.move({ direction: 'south' }); }
  else if (e.key === 'a' || e.key === 'A' || e.key === 'ArrowLeft') { conn.reducers.move({ direction: 'west' }); }
  else if (e.key === 'd' || e.key === 'D' || e.key === 'ArrowRight') { conn.reducers.move({ direction: 'east' }); }

  // Take newest takeable item on tile (berries before bushes)
  else if (e.key === 'e' || e.key === 'E') {
    const agent = getMyAgent();
    if (!agent) return;
    const takeable: any[] = [];
    for (const item of conn.db.nearbyItems.iter()) {
      if (!item.carrier && item.x === agent.x && item.y === agent.y
          && !hasTag(item.tags, 'blocking') && !hasTag(item.tags, 'rooted')) {
        takeable.push(item);
      }
    }
    takeable.sort((a, b) => Number(b.id - a.id)); // newest first
    if (takeable.length > 0) {
      conn.reducers.take({ itemId: takeable[0].id });
    }
  }

  // Drop selected (only if not bare hands)
  else if (e.key === 'q' || e.key === 'Q') {
    if (selectedSlot > 0) {
      const inv = getInventory();
      const item = inv[selectedSlot - 1];
      if (item) { conn.reducers.drop({ itemId: item.id }); }
    }
  }

  // Use mode
  else if (e.key === 'f' || e.key === 'F') {
    useMode = true;
  }

  // Select slot: 0 = bare hands, 1-8 = inventory
  else if (e.key === '0' || e.key === '`') {
    selectedSlot = 0; // bare hands
  }
  else if (e.key >= '1' && e.key <= '8') {
    selectedSlot = parseInt(e.key); // 1-8 for inventory
  }

  // Toggle item labels
  else if (e.key === 'l' || e.key === 'L') {
    showItemLabels = !showItemLabels;
  }

  // Chat
  else if (e.key === 'Enter') {
    chatOpen = true;
    chatInput.style.display = 'block';
    chatInput.focus();
  }
});

chatInput.addEventListener('input', (e) => {
  chatText = (e.target as HTMLInputElement).value;
});

// Mouse controls for camera (spectate mode)
canvas.addEventListener('mousedown', (e) => {
  if (!playing) {
    dragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    camStartX = camX;
    camStartY = camY;
  }
});
canvas.addEventListener('mousemove', (e) => {
  if (dragging) {
    camX = camStartX - (e.clientX - dragStartX) / zoom;
    camY = camStartY - (e.clientY - dragStartY) / zoom;
  }
});
canvas.addEventListener('mouseup', () => { dragging = false; });
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  zoom *= e.deltaY > 0 ? 0.9 : 1.1;
  zoom = Math.max(0.25, Math.min(4, zoom));
});

// ============================================================
// Watch for messages (views-based - tables are private)
// ============================================================
function setupCallbacks() {
  if (!conn) return;

  // My agent view callbacks
  conn.db.myAgent.onInsert((_ctx, agent) => {
    console.log('myAgent view onInsert:', agent.name);
    myAgentCache = agent;
    playing = true;
    playBtn.style.display = 'none';
  });

  conn.db.myAgent.onUpdate((_ctx, _old, updated) => {
    console.log('myAgent view onUpdate');
    myAgentCache = updated;
    if (Number(updated.lastActionAt) > Number(_old.lastActionAt)) {
      lastActionTime = Date.now();
      actionEffect = { type: 'success', x: updated.x, y: updated.y, time: Date.now() };
    }
  });

  conn.db.myAgent.onDelete((_ctx, _agent) => {
    console.log('myAgent view onDelete');
    myAgentCache = null;
    playing = false;
    playBtn.style.display = 'none';
    hud.style.display = 'none';
    const controlsHelp = document.getElementById('controls-help');
    if (controlsHelp) controlsHelp.style.display = 'none';
    const quitBtn = document.getElementById('quit-btn');
    if (quitBtn) quitBtn.style.display = 'none';
    showDeathScreen();
  });

  // Message view callbacks
  conn.db.nearbyMessages.onInsert((_ctx, msg) => {
    const msgAge = Date.now() - Number(msg.sentAt);
    if (msgAge > 10000) return;
    floatingMessages.push({
      text: `${msg.senderName}: ${msg.text}`,
      name: msg.senderName,
      x: msg.x,
      y: msg.y,
      time: Date.now(),
    });
  });
}

// Polling fallback: Check myAgent view in render loop
function checkMyAgentFromView() {
  if (!conn) return;

  let foundAgent: any = null;
  for (const a of conn.db.myAgent.iter()) {
    foundAgent = a;
    break;
  }

  // Detect agent appeared
  if (foundAgent && !myAgentCache) {
    console.log('Polling detected agent:', foundAgent.name);
    myAgentCache = foundAgent;
    playing = true;
    playBtn.style.display = 'none';
  }
  // Detect agent disappeared (death)
  else if (!foundAgent && myAgentCache) {
    console.log('Polling detected agent death');
    myAgentCache = null;
    playing = false;
    playBtn.style.display = 'none';
    hud.style.display = 'none';
    const controlsHelp = document.getElementById('controls-help');
    if (controlsHelp) controlsHelp.style.display = 'none';
    const quitBtn = document.getElementById('quit-btn');
    if (quitBtn) quitBtn.style.display = 'none';
    showDeathScreen();
  }
  // Update cache with latest data
  else if (foundAgent && myAgentCache) {
    const oldLastAction = Number(myAgentCache.lastActionAt);
    myAgentCache = foundAgent;
    if (Number(foundAgent.lastActionAt) > oldLastAction) {
      lastActionTime = Date.now();
      actionEffect = { type: 'success', x: foundAgent.x, y: foundAgent.y, time: Date.now() };
    }
  }
}

// ============================================================
// Death Screen
// ============================================================
function showDeathScreen() {
  // Create death overlay
  const overlay = document.createElement('div');
  overlay.id = 'death-overlay';
  overlay.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.8);
    display: flex; flex-direction: column;
    justify-content: center; align-items: center;
    z-index: 2000;
  `;

  overlay.innerHTML = `
    <div style="color: #cc2222; font-size: 72px; font-weight: bold; text-shadow: 0 0 20px #ff0000;">
      DEAD
    </div>
    <div style="color: #aaa; font-size: 18px; margin-top: 20px;">
      You have perished in ClawWorld
    </div>
    <button id="death-continue-btn" style="
      margin-top: 40px; padding: 15px 40px;
      font-size: 18px; cursor: pointer;
      background: #333; color: white; border: 2px solid #666;
      border-radius: 8px;
    ">
      Continue
    </button>
  `;

  document.body.appendChild(overlay);

  // Handle continue button
  const continueBtn = document.getElementById('death-continue-btn');
  if (continueBtn) {
    continueBtn.addEventListener('click', () => {
      overlay.remove();
      // Show welcome modal
      const modal = document.getElementById('welcome-modal');
      if (modal) modal.style.display = 'flex';
    });
  }
}

// ============================================================
// Init
// ============================================================
window.addEventListener('load', () => {
  connect();
});
