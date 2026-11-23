// Registry of migration sources (competitor platforms) and ScalePad utilities.
// To add a competitor: append an entry to MIGRATION_SOURCES. The rail, welcome
// screen, settings access list, and active-tab detection all read from here.
// Also add its origin to manifest.json `optional_host_permissions`.

window.MIGRATION_SOURCES = [
  {
    id: 'myitprocess',
    name: 'MyITProcess',
    tagline: 'Review templates, reviews, and roadmaps',
    description: 'Create assessment templates from your review templates, then migrate each client’s Alignment reviews as assessments and Strategy recommendations as initiatives.',
    fallback: 'MI',
    logo: '../icons/myitprocess-logo.png',
    origins: ['https://new.live.myitprocess.com/*'],
    match: /^https:\/\/new\.live\.myitprocess\.com\//i,
    startUrl: 'https://new.live.myitprocess.com/alignment',
    status: 'ready', // ready | building | planned
    alwaysGranted: true,
  },
  {
    id: 'propel',
    name: 'Propel Your MSP',
    tagline: 'Templates, assessments, and roadmaps',
    description: 'Create assessment and initiative templates from your Propel account, then migrate client assessments and roadmaps into ScalePad CS.',
    fallback: 'PY',
    logo: 'https://www.propelyourmsp.com/wp-content/uploads/2018/12/cropped-Propel-Your-MSP-Icon-square.png',
    origins: ['https://*.propelyourmsp.com/*'],
    match: /\.propelyourmsp\.com\//i,
    startUrl: 'https://app.propelyourmsp.com/',
    status: 'building',
  },
  {
    id: 'strategyoverview',
    name: 'Strategy Overview',
    tagline: 'Strategy templates, assessments, and roadmaps',
    description: 'Create assessment templates from your strategy templates, then migrate each client’s latest assessments, IT Plan and initiatives into ScalePad CS.',
    fallback: 'SO',
    logo: 'https://www.strategyoverview.com/wp-content/uploads/2026/08/so-symbol-white.svg',
    logoBg: '#0A1C2B',
    origins: ['https://*.strategyoverview.com/*'],
    match: /\.strategyoverview\.com\//i,
    startUrl: 'https://app.us.strategyoverview.com/',
    status: 'building',
  },
  {
    id: 'vciotoolbox',
    name: 'vCIO Toolbox',
    tagline: 'vCIO planning and client strategy',
    description: 'Capture vCIO planning, assessments, and client strategy data from vCIO Toolbox pages.',
    fallback: 'vC',
    logo: 'https://www.n-able.com/wp-content/uploads/2024/10/logo-vCiO-v1.png',
    origins: ['https://*.vciotoolbox.com/*'],
    match: /\.vciotoolbox\.com\//i,
    startUrl: 'https://vciotoolbox.com/',
    status: 'planned',
  },
  {
    id: 'connectwisecpq',
    name: 'ConnectWise CPQ',
    tagline: 'Quote templates into Quoter',
    description: 'Move your ConnectWise CPQ quote templates into Quoter.',
    destination: 'Quoter',
    fallback: 'CW',
    logo: '../icons/connectwise-cpq-logo.png',
    origins: ['https://*.quosalsell.com/*'],
    match: /\.quosalsell\.com\//i,
    startUrl: 'https://sellapp.quosalsell.com/',
    status: 'planned',
  },
];

window.SCALEPAD_UTILITIES = [
  {
    id: 'tenant-migration',
    name: 'Tenant migration',
    description: 'Copy client data between two ScalePad tenants with a tracked run.',
    icon: 'swap',
    accent: '#226093',
    status: 'ready',
  },
  {
    id: 'client-cleanup',
    name: 'Client clean up',
    description: 'Remove client data by record type, or your own templates and tags.',
    icon: 'eraser',
    accent: '#BB4A26',
    status: 'ready',
  },
  {
    id: 'controlmap-sync',
    name: 'ControlMap workstream sync',
    description: 'Review ControlMap risks and action items, then sync priorities into ScalePad CS.',
    icon: 'grid',
    accent: '#683568',
    status: 'ready',
  },
];

window.STATUS_LABELS = {
  ready: 'Ready',
  building: 'In progress',
  planned: 'Coming soon',
};
