import React from 'react';

const Breadcrumb = ({ currentPath, handleMenuClick }) => {
  const pathSegments = currentPath.split('/').filter((segment) => segment);

  return (
    <div className="breadcrumb">
      {pathSegments.map((segment, index) => {
        const fullPath = '/' + pathSegments.slice(0, index + 1).join('/');
        return (
          <span key={index} className="breadcrumb-segment">
            <button
              onClick={() => handleMenuClick(fullPath)}
              className="breadcrumb-link"
            >
              {segment}
            </button>
            {index < pathSegments.length - 1 && ' / '}
          </span>
        );
      })}
    </div>
  );
};

export default Breadcrumb;
