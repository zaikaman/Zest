import React from 'react';
import { motion } from 'framer-motion';
import { ArrowRight } from 'lucide-react';

const Hero: React.FC = () => {
  return (
    <section className="relative h-screen w-full flex items-center justify-center overflow-hidden pt-20">
      {/* Background Text Decor */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-5">
        <h1 className="text-[30vw] font-display font-bold leading-none select-none">
          SPEED
        </h1>
      </div>

      <div className="container mx-auto px-6 grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
        <div className="relative z-10">
          <motion.div
            initial={{ opacity: 0, x: -50 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.8, ease: "easeOut" }}
          >
            <span className="inline-block font-mono text-accent text-sm mb-4 tracking-[0.3em]">
              NEW DROP / SEASON 04
            </span>
            <h1 className="text-6xl md:text-8xl lg:text-9xl font-display font-bold leading-[0.9] mb-8">
              KINETIC <br />
              <span className="italic">EVOLUTION</span>
            </h1>
            <p className="max-w-md text-muted-foreground mb-10 font-mono text-sm leading-relaxed">
              Redefining the boundaries of human locomotion. 
              The KINETIC series is not just footwear; it's a structural 
              upgrade for the modern nomad.
            </p>
            <div className="flex flex-wrap gap-6">
              <a 
                href="#shop"
                className="group relative px-8 py-4 bg-foreground text-background font-mono text-xs font-bold overflow-hidden"
              >
                <span className="relative z-10 flex items-center gap-2">
                  EXPLORE ARTIFACTS <ArrowRight size={16} />
                </span>
                <motion.div 
                  className="absolute inset-0 bg-accent translate-y-full group-hover:translate-y-0 transition-transform duration-300"
                />
              </a>
              <button className="px-8 py-4 border border-border font-mono text-xs font-bold hover:bg-white/5 transition-colors">
                VIEW LOOKBOOK
              </button>
            </div>
          </motion.div>
        </div>

        <div className="relative">
          <motion.div
            initial={{ opacity: 0, scale: 0.8, rotate: 5 }}
            animate={{ opacity: 1, scale: 1, rotate: -5 }}
            transition={{ duration: 1.2, ease: "easeOut" }}
            className="relative z-10"
          >
            <img 
              src="https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&q=80&w=1200" 
              alt="Hero Shoe"
              className="w-full h-auto drop-shadow-[0_35px_35px_rgba(255,62,0,0.2)]"
            />
            
            {/* Callouts */}
            <div className="absolute top-1/4 -right-4 md:-right-12 hidden md:block">
              <div className="bg-background/80 backdrop-blur-sm border border-border p-4 font-mono text-[10px] space-y-1">
                <p className="text-accent">SPEC: CARBON_CHASSIS</p>
                <p>TENSION: 400N</p>
                <p>WEIGHT: 180G</p>
              </div>
            </div>
          </motion.div>
          
          {/* Geometric Accents */}
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[120%] h-[120%] border border-accent/10 rounded-full -z-10 animate-pulse" />
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[100%] h-[100%] border border-accent/20 rounded-full -z-10" />
        </div>
      </div>
    </section>
  );
};

export default Hero;