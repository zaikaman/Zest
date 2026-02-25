import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Trash2, Plus, Minus, ArrowRight } from 'lucide-react';
import { Product } from '../data/products';

interface CartProps {
  isOpen: boolean;
  onClose: () => void;
  items: { product: Product; quantity: number }[];
  onRemove: (id: string) => void;
  onUpdateQuantity: (id: string, delta: number) => void;
}

const Cart: React.FC<CartProps> = ({ isOpen, onClose, items, onRemove, onUpdateQuantity }) => {
  const total = items.reduce((acc, item) => acc + item.product.price * item.quantity, 0);

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-background/80 backdrop-blur-sm z-[60]"
          />
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="fixed top-0 right-0 h-full w-full max-w-md bg-background border-l border-border z-[70] flex flex-col"
          >
            <div className="p-6 border-b border-border flex items-center justify-between">
              <h2 className="text-2xl font-display font-bold">YOUR CART</h2>
              <button onClick={onClose} className="p-2 hover:text-accent transition-colors">
                <X size={24} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-8">
              {items.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center space-y-4">
                  <p className="font-mono text-muted-foreground">DATABASE EMPTY</p>
                  <button 
                    onClick={onClose}
                    className="text-accent font-mono text-sm underline underline-offset-4"
                  >
                    RETURN_TO_COLLECTION
                  </button>
                </div>
              ) : (
                items.map((item) => (
                  <div key={item.product.id} className="flex gap-4">
                    <div className="w-24 h-24 bg-muted border border-border flex-shrink-0">
                      <img 
                        src={item.product.image} 
                        alt={item.product.name} 
                        className="w-full h-full object-contain p-2"
                      />
                    </div>
                    <div className="flex-1 space-y-2">
                      <div className="flex justify-between">
                        <h4 className="font-display font-bold">{item.product.name}</h4>
                        <button 
                          onClick={() => onRemove(item.product.id)}
                          className="text-muted-foreground hover:text-accent"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                      <p className="font-mono text-xs text-muted-foreground">${item.product.price}.00</p>
                      
                      <div className="flex items-center gap-4">
                        <div className="flex items-center border border-border">
                          <button 
                            onClick={() => onUpdateQuantity(item.product.id, -1)}
                            className="p-1 hover:bg-muted"
                          >
                            <Minus size={14} />
                          </button>
                          <span className="w-8 text-center font-mono text-xs">{item.quantity}</span>
                          <button 
                            onClick={() => onUpdateQuantity(item.product.id, 1)}
                            className="p-1 hover:bg-muted"
                          >
                            <Plus size={14} />
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

            {items.length > 0 && (
              <div className="p-6 border-t border-border space-y-4">
                <div className="flex justify-between font-mono">
                  <span>SUBTOTAL</span>
                  <span className="text-xl font-bold">${total}.00</span>
                </div>
                <button className="w-full bg-foreground text-background py-4 font-mono font-bold flex items-center justify-center gap-2 group hover:bg-accent hover:text-white transition-colors">
                  PROCEED_TO_CHECKOUT <ArrowRight size={18} className="group-hover:translate-x-1 transition-transform" />
                </button>
                <p className="text-[10px] text-center text-muted-foreground font-mono">
                  SHIPPING AND TAXES CALCULATED AT CHECKOUT
                </p>
              </div>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
};

export default Cart;