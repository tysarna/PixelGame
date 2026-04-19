// Shared mutable state — all modules import from here

// Cognito config
export let COGNITO_USER_POOL_ID = window.COGNITO_USER_POOL_ID || 'us-east-1_T4Gej0pzm';
export let COGNITO_CLIENT_ID = window.COGNITO_CLIENT_ID || '5hh6ocl6llo47181epra7ombli';
export let COGNITO_REGION = window.COGNITO_REGION || 'us-east-1';

export const authState = {
  email: '',
  password: '',
  displayName: '',
  jwt: null,
  playerId: null
};

// Config / manifest / room
export let CFG = {};
export let MANIFEST = {};
export let ROOM = {};
export let TILESET = {};
export let TILE_SIZE = 32;
export let CELL = 32;
export let DIR_ROW = {};
export let POSE_COL = {};
export const WALK_SEQ = ['idle', 'stepA', 'idle', 'stepB'];

export const tileImages = {};
export const furnitureImages = {};

export const onlineState = new Map();
export let currentRoomId = 'lobby';

export let characters = [];
export let selectedChar = null;
export let spriteSheet = null;
export let player = { x: 6, y: 6, direction: 'down', pose: 'idle' };
export let walkIdx = 0;
export let walkTimer = null;
export let keysDown = new Set();
export let moveInterval = null;
export let gameLoop = null;
export let ws = null;
export let isLive = false;
export let genController = null;
export let genTimer = null;
export let gameState = { players: {}, furniture: {}, self: null, avatarUrl: null, direction: 'down', pose: 'idle' };
export let liveFurniture = [];
export let furnitureMode = null;
export const spriteCache = new Map();

// Template picker
export const ROOM_TEMPLATES = [
  { id: 'default', name: 'Cozy Home' },
  { id: 'cozy',    name: 'Warm Lounge' },
  { id: 'cafe',    name: 'Street Cafe' },
  { id: 'library', name: 'Grand Library' },
];
export let templateIdx = 0;

export let SCALE = 2;
export let tileCanvasCache = null;
export const TILE_FALLBACK = {
  wall_stone:  '#2a2e3e', wall_window: '#2a3550', floor_wood: '#3d2b1e',
  floor_stone: '#2c2c38', door_wood:   '#4a3020', rug_center: '#4a2030',
  wall_brick:  '#5c2a1a', floor_carpet:'#1a3a2a', floor_marble:'#d8d8e0',
};

// Furniture edit state
export let furnEditMode = false;
export let furnDrag = null;
export let selectedFurnInstance = null;
export let furnPreview = null; // { tileX, tileY } — where to draw the ghost
export let _dragJustEnded = false;
export let lastMoveTime = 0;
export const MOVE_COOLDOWN = 200;

// Setters for `let` exports (modules can't reassign imported lets)
export function setCFG(v) { CFG = v; }
export function setMANIFEST(v) { MANIFEST = v; }
export function setROOM(v) { ROOM = v; }
export function setTILESET(v) { TILESET = v; }
export function setTILE_SIZE(v) { TILE_SIZE = v; }
export function setCELL(v) { CELL = v; }
export function setDIR_ROW(v) { DIR_ROW = v; }
export function setPOSE_COL(v) { POSE_COL = v; }
export function setCurrentRoomId(v) { currentRoomId = v; }
export function setCharacters(v) { characters = v; }
export function setSelectedChar(v) { selectedChar = v; }
export function setSpriteSheet(v) { spriteSheet = v; }
export function setPlayer(v) { player = v; }
export function setWalkIdx(v) { walkIdx = v; }
export function setWalkTimer(v) { walkTimer = v; }
export function setMoveInterval(v) { moveInterval = v; }
export function setGameLoop(v) { gameLoop = v; }
export function setWs(v) { ws = v; }
export function setIsLive(v) { isLive = v; }
export function setGenController(v) { genController = v; }
export function setGenTimer(v) { genTimer = v; }
export function setGameState(v) { gameState = v; }
export function setLiveFurniture(v) { liveFurniture = v; }
export function setFurnitureMode(v) { furnitureMode = v; }
export function setTemplateIdx(v) { templateIdx = v; }
export function setSCALE(v) { SCALE = v; }
export function setTileCanvasCache(v) { tileCanvasCache = v; }
export function setFurnEditMode(v) { furnEditMode = v; }
export function setFurnDrag(v) { furnDrag = v; }
export function setSelectedFurnInstance(v) { selectedFurnInstance = v; }
export function setFurnPreview(v) { furnPreview = v; }
export function setDragJustEnded(v) { _dragJustEnded = v; }
export function setLastMoveTime(v) { lastMoveTime = v; }
