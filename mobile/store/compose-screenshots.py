# Frames raw 1320x2868 simulator captures ($SHOTS_DIR/<name>.png) for the App Store:
# writes screenshots/6.9-raw and screenshots/6.9-captioned. Needs Pillow. See APP_STORE.md.
import sys
from PIL import Image, ImageDraw, ImageFont
import os
ROOT=os.path.dirname(os.path.abspath(__file__))
S=os.environ.get('SHOTS_DIR','/tmp/hermetic-shots/')
O=os.path.join(ROOT,'screenshots')+'/'
F=os.path.join(ROOT,'..','assets','fonts')+'/'
shots=[
 ('home','Every agent in\nyour fleet','One screen. Anything waiting on you comes first.','dark'),
 ('chat-approval','Unblock an agent\nfrom anywhere','Approve, allow for the session, or deny.','dark'),
 ('chat-md','The same chat\nas the desktop','Tables, code, images and tool calls, in full.','dark'),
 ('chat-tools','Straight to\nyour own boxes','Over your Tailscale network. No server in between.','dark'),
 ('settings-notif','Quiet pushes\nby default','Which bot needs you, and nothing of what was said.','dark'),
 ('settings','Fleet health\nat a glance','Status and version for every agent.','dark'),
 ('home-light','Light or dark,\nyour call','Follows your iPhone, or pick one.','light'),
]
W,H=1320,2868
for i,(n,title,sub,mode) in enumerate(shots,1):
    im=Image.open(S+n+'.png').convert('RGB')
    assert im.size==(W,H), im.size
    im.save(f'{O}6.9-raw/{i:02d}-{n}.png')
    bg=(14,14,13) if mode=='dark' else (240,238,232)
    fg=(240,238,232) if mode=='dark' else (14,14,13)
    mu=(160,158,150) if mode=='dark' else (90,88,82)
    c=Image.new('RGB',(W,H),bg); d=ImageDraw.Draw(c)
    # accent bar
    d.rectangle((110,170,190,182),fill=(255,90,31))
    tf=ImageFont.truetype(F+'Archivo-ExtraBold.ttf',100)
    sf=ImageFont.truetype(F+'Archivo-Regular.ttf',46)
    d.multiline_text((110,215),title,font=tf,fill=fg,spacing=14)
    d.text((110,465),sub,font=sf,fill=mu)
    # screenshot scaled, with border, bottom bleed
    sw=int(W*0.82); sh=int(H*0.82); x=(W-sw)//2; y=610
    shot=im.resize((sw,sh),Image.LANCZOS)
    border=(60,60,56) if mode=='dark' else (200,198,190)
    d.rectangle((x-6,y-6,x+sw+5,y+sh+5),fill=border)
    c.paste(shot,(x,y))
    c.save(f'{O}6.9-captioned/{i:02d}-{n}.png')
    # width check of title
    print(n, max(d.textlength(t,font=tf) for t in title.split('\n')), d.textlength(sub,font=sf))
