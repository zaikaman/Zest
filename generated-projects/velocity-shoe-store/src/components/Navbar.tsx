import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { ShoppingBag, Search } from 'lucide-react';

interface NavbarProps {
  cartCount: number;
  onOpenCart: () => void;
}

const Navbar: React.FC<NavbarProps> = ({ cartCount, onOpenCart }) => {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 50);
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  return (
    <motion.nav
      initial={{ y: -100 }}
      animate={{ y: 0 }}
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-500 px-6 md:px-12 py-6 flex items-center justify-between ${
        scrolled ? 'bg-background/80 backdrop-blur-md border-b border-border py-4' : 'bg-transparent'
      }`}
    >
      <div className="flex items-center gap-8">
        <a href="#" className="text-2xl font-display font-bold tracking-tighter">
          V<span className="text-accent">.</span>ARTIFACTS
        </a>
        <div className="hidden md:flex items-center gap-6 font-mono text-[10px] tracking-widest">
          <a href="#shop" className="hover:text-accent transition-colors">SHOP</a>
          <a href="#" className="hover:text-accent transition-colors">ARCHIVE</a>
          <a href="#" className="hover:text-accent transition-colors">LAB</a>
        </div>
      </div>

      <div className="flex items-center gap-6">
        <button className="p-2 hover:text-accent transition-colors">
          <Search size={20} />
        </button>
        <button 
          onClick={onOpenCart}
          className="group relative flex items-center gap-2 p-2"
        >
          <ShoppingBag size={20} className="group-hover:text-accent transition-colors" />
          <span className="font-mono text-xs bg-accent text-white px-1.5 py-0.5 min-w-[1.2rem] text-center">
            {cartCount}
          </span>
        </button>
      </div>
    </motion.nav>
  );
};

export default Navbar;