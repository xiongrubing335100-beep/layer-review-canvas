"""Bounded whole-RGBA coordinate correction from reciprocal source features.

This maps coordinates only. It cannot paint RGB, change alpha topology or
invent missing foreground. Held-out matches and field geometry are independent
of the fitting residual and are required before the map may be sampled.
"""
import math
import cv2
import numpy as np
from scipy.interpolate import RBFInterpolator
from scipy.spatial import cKDTree

def fit_local_map(generated, source, size):
    p,q=np.asarray(generated,dtype=np.float64),np.asarray(source,dtype=np.float64)
    width,height=size
    if p.shape!=q.shape or p.ndim!=2 or p.shape[1]!=2 or len(p)<60 or not np.isfinite([p,q]).all():
        raise ValueError('NATIVE_LOCAL_INSUFFICIENT_MATCHES')
    cv2.setRNGSeed(2718)
    matrix,inliers=cv2.estimateAffinePartial2D(p,q,method=cv2.RANSAC,
        ransacReprojThreshold=3,maxIters=5000,confidence=.999,refineIters=20)
    if matrix is None or inliers is None or inliers.sum()<20:
        raise ValueError('NATIVE_LOCAL_NO_GLOBAL_ANCHOR')
    scale=math.hypot(matrix[0,0],matrix[1,0])
    if not .7<=scale<=1.4 or abs(math.degrees(math.atan2(matrix[1,0],matrix[0,0])))>5:
        raise ValueError('NATIVE_LOCAL_GLOBAL_GEOMETRY')
    if np.linalg.norm(matrix[:,2])>.25*math.hypot(width,height):
        raise ValueError('NATIVE_LOCAL_GLOBAL_GEOMETRY')
    inverse=cv2.invertAffineTransform(matrix)
    offsets=p-cv2.transform(q[None],inverse)[0]
    limit=.022*math.hypot(width,height)
    keep=np.linalg.norm(offsets,axis=1)<limit
    p,q,offsets=p[keep],q[keep],offsets[keep]
    if len(q)<60: raise ValueError('NATIVE_LOCAL_INSUFFICIENT_SUPPORT')
    neighbours=cKDTree(q).query(q,k=9)[1]
    keep=np.linalg.norm(offsets-np.median(offsets[neighbours],axis=1),axis=1)<5
    p,q,offsets=p[keep],q[keep],offsets[keep]
    _,unique=np.unique(np.rint(q/2).astype(int),axis=0,return_index=True)
    p,q,offsets=p[unique],q[unique],offsets[unique]
    if len(q)<60 or len(q)<len(generated)*.65 or min(np.ptp(q,axis=0)/[width,height])<.3:
        raise ValueError('NATIVE_LOCAL_INSUFFICIENT_SUPPORT')
    hold=np.arange(len(q))%5==0
    training=RBFInterpolator(q[~hold]/100,offsets[~hold],kernel='thin_plate_spline',smoothing=.5)
    errors=np.linalg.norm(training(q[hold]/100)-offsets[hold],axis=1)*scale
    if np.quantile(errors,.95)>3 or errors.max()>6:
        raise ValueError('NATIVE_LOCAL_HOLDOUT_FAILED')
    fit=RBFInterpolator(q/100,offsets,kernel='thin_plate_spline',smoothing=.5)
    gx=np.linspace(0,width-1,math.ceil(width/8)+1)
    gy=np.linspace(0,height-1,math.ceil(height/8)+1)
    xx,yy=np.meshgrid(gx,gy)
    delta=fit(np.stack([xx.ravel(),yy.ravel()],axis=1)/100).reshape(*xx.shape,2)
    if np.linalg.norm(delta,axis=2).max()>limit:
        raise ValueError('NATIVE_LOCAL_EXTRAPOLATION')
    # Relative to the global inverse, reject folding and excessive local strain.
    ux_y,ux_x=np.gradient(delta[...,0],gy,gx)
    uy_y,uy_x=np.gradient(delta[...,1],gy,gx)
    jac=np.empty((*xx.shape,2,2))
    jac[...,0,0]=inverse[0,0]+ux_x;jac[...,0,1]=inverse[0,1]+ux_y
    jac[...,1,0]=inverse[1,0]+uy_x;jac[...,1,1]=inverse[1,1]+uy_y
    relative=jac@matrix[:,:2]
    singular=np.linalg.svd(relative,compute_uv=False)
    determinant=np.linalg.det(relative)
    if determinant.min()<.5 or singular.min()<.75 or singular.max()>1.25:
        raise ValueError('NATIVE_LOCAL_FOLD_OR_STRAIN')
    result={'inverse':inverse,'delta':delta.astype(np.float32),'size':size,'scale':scale}
    audit={'status':'passed','method':'source_reciprocal_local_map','matches':len(generated),
        'supportedMatches':len(q),'holdoutMatches':int(hold.sum()),
        'holdoutP95SourcePixels':float(np.quantile(errors,.95)),
        'minimumRelativeJacobian':float(determinant.min()),
        'minimumRelativeStretch':float(singular.min()),'maximumRelativeStretch':float(singular.max()),
        'maximumResidualDisplacement':float(np.linalg.norm(delta,axis=2).max()),
        'matrix':matrix.tolist(),'transparentRgbIgnored':True,'alphaAndRgbShareMap':True}
    return result,audit

def map_points(transform,points):
    points=np.asarray(points,dtype=np.float32)
    delta=transform['delta'];width,height=transform['size']
    x=points[...,0]*(delta.shape[1]-1)/(width-1)
    y=points[...,1]*(delta.shape[0]-1)/(height-1)
    # OpenCV limits a remap axis to 32766; source images can exceed that many
    # total samples even in one renderer strip. Keep bounded chunks.
    flat_x,flat_y=x.reshape(-1),y.reshape(-1)
    sampled=np.concatenate([cv2.remap(delta,flat_x[start:start+16384,None],
        flat_y[start:start+16384,None],cv2.INTER_LINEAR,borderMode=cv2.BORDER_REPLICATE).reshape(-1,2)
        for start in range(0,len(flat_x),16384)]).reshape(points.shape)
    return cv2.transform(points.reshape(1,-1,2),transform['inverse'])[0].reshape(points.shape)+sampled

def estimate_local_alignment(source_gray,generated_gray,alpha):
    sift=cv2.SIFT_create(nfeatures=6000)
    first,d=sift.detectAndCompute(source_gray,None)
    second,e=sift.detectAndCompute(generated_gray,(alpha>200).astype(np.uint8)*255)
    if d is None or e is None or min(len(d),len(e))<2:
        raise ValueError('NATIVE_LOCAL_INSUFFICIENT_FEATURES')
    matcher=cv2.BFMatcher()
    reverse={a.queryIdx:a.trainIdx for a,b in matcher.knnMatch(d,e,k=2) if a.distance<.7*b.distance}
    matches=[a for a,b in matcher.knnMatch(e,d,k=2)
             if a.distance<.7*b.distance and reverse.get(a.trainIdx)==a.queryIdx]
    p=np.float64([second[m.queryIdx].pt for m in matches])
    q=np.float64([first[m.trainIdx].pt for m in matches])
    return fit_local_map(p,q,(alpha.shape[1],alpha.shape[0]))
