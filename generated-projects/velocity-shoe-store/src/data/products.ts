export interface Product {
  id: string;
  name: string;
  category: 'PERFORMANCE' | 'ARCHIVE' | 'COLLAB';
  price: number;
  image: string;
  description: string;
  specs: string[];
}

export const products: Product[] = [
  {
    id: 'va-01',
    name: 'KINETIC V1 "CORE"',
    category: 'PERFORMANCE',
    price: 320,
    image: 'https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&q=80&w=1000',
    description: 'Engineered for high-torque lateral movement. Features our proprietary carbon-fiber weave chassis.',
    specs: ['Carbon Fiber Plate', 'Breathable Mesh', 'High-Traction Outsole']
  },
  {
    id: 'va-02',
    name: 'MONOLITH 0.8',
    category: 'ARCHIVE',
    price: 450,
    image: 'https://images.unsplash.com/photo-1606107557195-0e29a4b5b4aa?auto=format&fit=crop&q=80&w=1000',
    description: 'A study in structural minimalism. Hand-stitched premium leather over a sculptural EVA midsole.',
    specs: ['Italian Calfskin', 'Hand-Stitched', 'Limited Edition']
  },
  {
    id: 'va-03',
    name: 'X-TREME TERRAIN',
    category: 'PERFORMANCE',
    price: 280,
    image: 'https://images.unsplash.com/photo-1605348532760-6753d2c43329?auto=format&fit=crop&q=80&w=1000',
    description: 'Built for the elements. Waterproof membrane with aggressive multi-directional lug pattern.',
    specs: ['Gore-Tex Upper', 'Vibram Outsole', 'Quick-Lace System']
  },
  {
    id: 'va-04',
    name: 'NEON GHOST',
    category: 'COLLAB',
    price: 520,
    image: 'https://images.unsplash.com/photo-1595950653106-6c9ebd614d3a?auto=format&fit=crop&q=80&w=1000',
    description: 'A collaboration with Studio Obscura. Translucent panels reveal the internal structural ribbing.',
    specs: ['Translucent TPU', 'Reactive Foam', 'Serialized Edition']
  },
  {
    id: 'va-05',
    name: 'VOID RUNNER',
    category: 'PERFORMANCE',
    price: 380,
    image: 'https://images.unsplash.com/photo-1551107696-a4b0c5a0d9a2?auto=format&fit=crop&q=80&w=1000',
    description: 'Maximum energy return. The Void Runner uses localized compression zones for effortless propulsion.',
    specs: ['Compression Tech', 'Ultra-Light', 'Seamless Fit']
  },
  {
    id: 'va-06',
    name: 'ARCHIVE 99',
    category: 'ARCHIVE',
    price: 210,
    image: 'https://images.unsplash.com/photo-1539185441755-769473a23570?auto=format&fit=crop&q=80&w=1000',
    description: 'A reissue of our first silhouette. Classic aesthetics meet modern material science.',
    specs: ['Suede Overlays', 'Retro Fit', 'Daily Driver']
  }
];