import React from 'react';
import { motion } from 'framer-motion';
import { Plus, Eye } from 'lucide-react';
import { Product } from '../data/products';

interface ProductGridProps {
  products: Product[];
  onAddToCart: (product: Product) => void;
}

const ProductGrid: React.FC<ProductGridProps> = ({ products, onAddToCart }) => {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-16">
      {products.map((product, index) => (
        <motion.div
          key={product.id}
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ delay: index * 0.1 }}
          className="group"
        >
          <div className="relative aspect-[4/5] bg-muted overflow-hidden mb-6 border border-border/50 group-hover:border-accent/50 transition-colors duration-500">
            {/* Product Category Tag */}
            <div className="absolute top-4 left-4 z-20">
              <span className="bg-background text-[10px] font-mono px-2 py-1 border border-border">
                {product.category}
              </span>
            </div>

            {/* Price Tag */}
            <div className="absolute top-4 right-4 z-20">
              <span className="font-mono text-sm font-bold">
                ${product.price}.00
              </span>
            </div>

            {/* Image Container */}
            <motion.div 
              className="w-full h-full p-8 flex items-center justify-center transition-transform duration-700 ease-out group-hover:scale-110"
            >
              <img 
                src={product.image} 
                alt={product.name}
                className="w-full h-full object-contain grayscale-[0.2] group-hover:grayscale-0 transition-all duration-500"
              />
            </motion.div>

            {/* Hover Actions */}
            <div className="absolute inset-0 bg-background/40 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-center justify-center gap-4">
              <button 
                onClick={() => onAddToCart(product)}
                className="bg-foreground text-background p-4 rounded-full hover:bg-accent hover:text-white transition-colors"
              >
                <Plus size={24} />
              </button>
              <button className="bg-foreground text-background p-4 rounded-full hover:bg-accent hover:text-white transition-colors">
                <Eye size={24} />
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex justify-between items-start">
              <h3 className="text-2xl font-display font-bold group-hover:text-accent transition-colors">
                {product.name}
              </h3>
              <span className="font-mono text-[10px] text-muted-foreground mt-2">
                REF: {product.id}
              </span>
            </div>
            
            <p className="text-sm text-muted-foreground font-mono leading-relaxed line-clamp-2">
              {product.description}
            </p>

            <div className="pt-4 flex flex-wrap gap-2">
              {product.specs.slice(0, 2).map((spec, i) => (
                <span key={i} className="text-[9px] font-mono border border-border px-2 py-0.5 opacity-60">
                  {spec}
                </span>
              ))}
            </div>
          </div>
        </motion.div>
      ))}
    </div>
  );
};

export default ProductGrid;