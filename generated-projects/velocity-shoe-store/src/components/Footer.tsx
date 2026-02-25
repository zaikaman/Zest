import React from 'react';

const Footer: React.FC = () => {
  return (
    <footer className="bg-background border-t border-border pt-24 pb-12 px-6 md:px-12">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-12 mb-24">
        <div className="col-span-1 lg:col-span-2">
          <h2 className="text-4xl md:text-6xl font-display font-bold mb-8">
            STAY <br /> <span className="italic">KINETIC</span>
          </h2>
          <p className="font-mono text-sm text-muted-foreground max-w-sm mb-8">
            Join the collective. Receive updates on new artifacts, 
            exclusive drops, and archival releases.
          </p>
          <div className="flex max-w-md">
            <input 
              type="email" 
              placeholder="ENTER_EMAIL_ADDRESS"
              className="flex-1 bg-transparent border-b border-border py-4 font-mono text-xs focus:outline-none focus:border-accent transition-colors"
            />
            <button className="border-b border-border px-4 font-mono text-xs hover:text-accent transition-colors">
              JOIN
            </button>
          </div>
        </div>

        <div>
          <h4 className="font-mono text-xs font-bold mb-6 tracking-widest">NAVIGATION</h4>
          <ul className="space-y-4 font-mono text-xs text-muted-foreground">
            <li><a href="#" className="hover:text-foreground transition-colors">SHOP_ALL</a></li>
            <li><a href="#" className="hover:text-foreground transition-colors">NEW_ARRIVALS</a></li>
            <li><a href="#" className="hover:text-foreground transition-colors">ARCHIVE_00</a></li>
            <li><a href="#" className="hover:text-foreground transition-colors">LAB_REPORTS</a></li>
          </ul>
        </div>

        <div>
          <h4 className="font-mono text-xs font-bold mb-6 tracking-widest">CONNECT</h4>
          <ul className="space-y-4 font-mono text-xs text-muted-foreground">
            <li><a href="#" className="hover:text-foreground transition-colors">INSTAGRAM</a></li>
            <li><a href="#" className="hover:text-foreground transition-colors">TWITTER</a></li>
            <li><a href="#" className="hover:text-foreground transition-colors">DISCORD</a></li>
            <li><a href="#" className="hover:text-foreground transition-colors">CONTACT_US</a></li>
          </ul>
        </div>
      </div>

      <div className="flex flex-col md:flex-row justify-between items-center gap-6 pt-12 border-t border-border/50">
        <p className="font-mono text-[10px] text-muted-foreground">
          &copy; 2024 VELOCITY ARTIFACTS. ALL RIGHTS RESERVED.
        </p>
        <div className="flex gap-8 font-mono text-[10px] text-muted-foreground">
          <a href="#" className="hover:text-foreground">PRIVACY_POLICY</a>
          <a href="#" className="hover:text-foreground">TERMS_OF_SERVICE</a>
          <a href="#" className="hover:text-foreground">SHIPPING_INFO</a>
        </div>
      </div>
    </footer>
  );
};

export default Footer;