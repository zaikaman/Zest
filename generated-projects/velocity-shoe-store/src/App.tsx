import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ShoppingBag, Menu, X, ArrowRight, ChevronRight, Search, Filter } from 'lucide-react';
import { products, Product } from './data/products';
import Navbar from './components/Navbar';
import Hero from './components/Hero';
import ProductGrid from './components/ProductGrid';
import Cart from './components/Cart';
import Footer from './components/Footer';

const App: React.FC = () => {
  const [cartItems, setCartItems] = useState<{ product: Product; quantity: number }[]>([]);
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [activeCategory, setActiveCategory] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  const addToCart = (product: Product) => {
    setCartItems(prev => {
      const existing = prev.find(item => item.product.id === product.id);
      if (existing) {
        return prev.map(item => 
          item.product.id === product.id ? { ...item, quantity: item.quantity + 1 } : item
        );
      }
      return [...prev, { product, quantity: 1 }];
    });
    setIsCartOpen(true);
  };

  const removeFromCart = (productId: string) => {
    setCartItems(prev => prev.filter(item => item.product.id !== productId));
  };

  const updateQuantity = (productId: string, delta: number) => {
    setCartItems(prev => prev.map(item => {
      if (item.product.id === productId) {
        const newQty = Math.max(1, item.quantity + delta);
        return { ...item, quantity: newQty };
      }
      return item;
    }));
  };

  const filteredProducts = products.filter(p => {
    const matchesCategory = activeCategory === 'ALL' || p.category === activeCategory;
    const matchesSearch = p.name.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesCategory && matchesSearch;
  });

  return (
    <div className="min-h-screen bg-background text-foreground font-sans selection:bg-accent selection:text-white">
      <div className="fixed inset-0 grid-bg opacity-20 pointer-events-none z-0" />
      
      <Navbar 
        cartCount={cartItems.reduce((acc, item) => acc + item.quantity, 0)} 
        onOpenCart={() => setIsCartOpen(true)} 
      />

      <main className="relative z-10">
        <Hero />
        
        <section id="shop" className="px-6 md:px-12 py-24">
          <div className="flex flex-col md:flex-row md:items-end justify-between mb-16 gap-8">
            <div>
              <motion.h2 
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                className="text-5xl md:text-7xl font-display mb-4"
              >
                THE <span className="italic">COLLECTION</span>
              </motion.h2>
              <motion.p 
                initial={{ opacity: 0 }}
                whileInView={{ opacity: 1 }}
                viewport={{ once: true }}
                transition={{ delay: 0.2 }}
                className="text-muted-foreground font-mono text-sm max-w-md"
              >
                [SYSTEM_UPDATE_2.4]: NEW ARTIFACTS LOADED INTO THE DATABASE. 
                CHOOSE YOUR INTERFACE.
              </motion.p>
            </div>

            <div className="flex flex-wrap gap-4">
              {['ALL', 'PERFORMANCE', 'ARCHIVE', 'COLLAB'].map((cat) => (
                <button
                  key={cat}
                  onClick={() => setActiveCategory(cat)}
                  className={`px-4 py-2 font-mono text-xs border transition-all duration-300 ${
                    activeCategory === cat 
                      ? 'bg-accent border-accent text-white' 
                      : 'border-border hover:border-accent'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>

          <ProductGrid 
            products={filteredProducts} 
            onAddToCart={addToCart} 
          />
        </section>

        <section className="py-24 overflow-hidden border-y border-border">
          <div className="flex whitespace-nowrap animate-marquee">
            {[...Array(10)].map((_, i) => (
              <span key={i} className="text-8xl md:text-[12rem] font-display font-bold text-outline px-8">
                VELOCITY ARTIFACTS
              </span>
            ))}
          </div>
        </section>
      </main>

      <Cart 
        isOpen={isCartOpen} 
        onClose={() => setIsCartOpen(false)} 
        items={cartItems}
        onRemove={removeFromCart}
        onUpdateQuantity={updateQuantity}
      />

      <Footer />
    </div>
  );
};

export default App;