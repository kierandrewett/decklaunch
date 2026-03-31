import {
  // Apps / launchers
  Chrome, Globe, AppWindow, Terminal,
  // Audio / media
  Volume1, Volume2, VolumeX, Mic, MicOff, Music, Headphones,
  Play, Pause, SkipForward, SkipBack, Radio,
  // System / hardware
  Monitor, Cpu, Thermometer, HardDrive, MemoryStick,
  Battery, BatteryCharging, Wifi, WifiOff,
  // UI / actions
  MousePointer, Mouse, Keyboard, Power,
  RefreshCw, Settings, Zap, Bell, BellOff,
  Trash2, Copy, X, Plus, Check,
  // Weather extras
  Droplets, Wind,
  // Misc
  Cloud, Sun, CloudRain, CloudSnow,
  Clock, Calendar, Star, Heart,
  Camera, Image, Film,
  Mail, MessageSquare, Phone,
  Lock, Unlock, Key, Shield,
  Home, Server, Laptop, Smartphone,
  Square, LayoutGrid, Layers,
  ArrowUp, ArrowDown, ChevronRight,
  Gamepad2, Joystick,
} from 'lucide';

// Map kebab-case config names → lucide icon node arrays
export const ICONS = {
  'chrome':           Chrome,
  'globe':            Globe,
  'app-window':       AppWindow,
  'terminal':         Terminal,
  'volume-1':         Volume1,
  'volume-2':         Volume2,
  'volume-x':         VolumeX,
  'mic':              Mic,
  'mic-off':          MicOff,
  'music':            Music,
  'headphones':       Headphones,
  'play':             Play,
  'pause':            Pause,
  'skip-forward':     SkipForward,
  'skip-back':        SkipBack,
  'radio':            Radio,
  'monitor':          Monitor,
  'cpu':              Cpu,
  'thermometer':      Thermometer,
  'hard-drive':       HardDrive,
  'memory-stick':     MemoryStick,
  'battery':          Battery,
  'battery-charging': BatteryCharging,
  'wifi':             Wifi,
  'wifi-off':         WifiOff,
  'mouse-pointer':    MousePointer,
  'mouse':            Mouse,
  'keyboard':         Keyboard,
  'power':            Power,
  'refresh-cw':       RefreshCw,
  'settings':         Settings,
  'zap':              Zap,
  'bell':             Bell,
  'bell-off':         BellOff,
  'droplets':         Droplets,
  'wind':             Wind,
  'cloud':            Cloud,
  'sun':              Sun,
  'cloud-rain':       CloudRain,
  'cloud-snow':       CloudSnow,
  'clock':            Clock,
  'calendar':         Calendar,
  'star':             Star,
  'heart':            Heart,
  'camera':           Camera,
  'image':            Image,
  'film':             Film,
  'mail':             Mail,
  'message-square':   MessageSquare,
  'phone':            Phone,
  'lock':             Lock,
  'unlock':           Unlock,
  'key':              Key,
  'shield':           Shield,
  'home':             Home,
  'server':           Server,
  'laptop':           Laptop,
  'smartphone':       Smartphone,
  'square':           Square,
  'layout-grid':      LayoutGrid,
  'layers':           Layers,
  'arrow-up':         ArrowUp,
  'arrow-down':       ArrowDown,
  'chevron-right':    ChevronRight,
  'gamepad-2':        Gamepad2,
  'joystick':         Joystick,
  'trash-2':          Trash2,
  'copy':             Copy,
  'x':                X,
  'plus':             Plus,
  'check':            Check,
};

/**
 * Create a DOM SVG element for the named lucide icon.
 * Falls back to Square if the name isn't found.
 */
export function createIcon(name, { size = 24, className = '' } = {}) {
  const iconData = ICONS[name] ?? ICONS['square'];
  return buildSvg(iconData, size, className);
}

function buildSvg(iconData, size, className) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  if (className) svg.setAttribute('class', className);

  // lucide exports: ["svg", {attrs}, [["path", {attrs}, []], ...]]
  const children = iconData[2] ?? [];
  for (const child of children) {
    svg.appendChild(buildNode(ns, child));
  }
  return svg;
}

function buildNode(ns, node) {
  const [tag, attrs, children = []] = node;
  const el = document.createElementNS(ns, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const child of children) el.appendChild(buildNode(ns, child));
  return el;
}
