import React from 'react';
import './Marquee.css';

interface MarqueeProps {
    text: string;
    reverse?: boolean;
}

const Marquee: React.FC<MarqueeProps> = ({ text, reverse = false }) => {
    return (
        <div className="marquee-container">
            <div className={`marquee-content ${reverse ? 'reverse' : ''}`}>
                <span>{text}</span>
                <span>{text}</span>
                <span>{text}</span>
                <span>{text}</span>
            </div>
        </div>
    );
};

export default Marquee;
