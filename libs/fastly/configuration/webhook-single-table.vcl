table redirect_one_to_one_urls {
  "edutest.risd.systems/uploadedFiles/RISD_edu/About_RISD/FAQ/fact_book_2016_160511.pdf": "http://info.risd.edu/webhook-uploads/1462988813309/fact_book_2016_160511.pdf",
  "edutest.risd.systems/summerstudies/": "https://summer.risd.edu",
  "edutest.risd.systems/teaching+learning-in-art+design/": "edutest.risd.systems/academics/teaching-learning-in-art-design/",
  "edutest.risd.systems/teaching-learning-in-art-design/": "edutest.risd.systems/academics/teaching-learning-in-art-design/",
  "edutest.risd.systems/textiles/": "edutest.risd.systems/academics/textiles/",
  "edutest.risd.systems/thesis/": "http://gradshow.risd.edu/",
  "edutest.risd.systems/tlad/": "edutest.risd.systems/academics/teaching-learning-in-art-design/",
  "edutest.risd.systems/videos/": "https://vimeo.com/risd",
  "edutest.risd.systems/viewbook/": "https://admissions.risd.edu/register/information_request/",
  "edutest.risd.systems/visit/": "edutest.risd.systems/about/visiting-risd/",
  "edutest.risd.systems/welcome/": "http://congratulations.risd.edu/",
  "diff.edutest.risd.systems/wintersession/": "diff.edutest.risd.systems/academics/wintersession/",
  "diff.edutest.risd.systems/xyz/": "diff.edutest.risd.systems/alumni/risd-xyz/",
  "diff.edutest.risd.systems/xyzmail/": "diff.edutest.risd.systems/alumni/risd-xyz/",
  "www.perpetualhappiness.com/short-url/": "www.perpetualhappiness.com/pages/second/",
}

table hosts_to_redirect {
  "risd.edu": "www.risd.edu",
  "perpetualhappiness.com": "www.perpetualhappiness.com",
}


sub vcl_recv {
#FASTLY recv
  
  # Snippet host_redirect : 98
  if ( table.lookup( hosts_to_redirect, req.http.host ) ) {
    set req.http.x-redirect-location = "http://" table.lookup( hosts_to_redirect, req.http.host ) req.url;
    error 301;
  }
        
    
  # Snippet recv_trailing_slash : 99
  if ( req.url !~ {"(?x)
 (?:/$) # last character isn't a slash
 | # or 
 (?:/\?) # query string isn't immediately preceded by a slash
 "} &&
 req.url ~ {"(?x)
 (?:/[^./]+$) # last path segment doesn't contain a . no query string
 | # or
 (?:/[^.?]+\?) # last path segment doesn't contain a . with a query string
 "} ) {

  set req.http.x-redirect-location = req.url "/";

  error 301;
}

  # Snippet recv_redirect_urls : 100
  declare local var.host_path STRING;

  set var.host_path = req.http.host req.url.path;

  if ( table.lookup( redirect_one_to_one_urls, var.host_path ) ) {
    declare local var.redirect_location STRING;
    set var.redirect_location = table.lookup( redirect_one_to_one_urls, var.host_path );
    
    if ( ! ( var.redirect_location ~ "^http"  ) ){
      set var.redirect_location = "http://" var.redirect_location;
    }

    set req.http.x-redirect-location = var.redirect_location;
  
    error 301;
  }

  # Snippet redirect_1c1t3b1e2f201y2y263b1c2f332c33362q1b1d1w22291p1p : 100
  if ( req.http.host == "diff.edutest.risd.systems" && req.url ~ "^/academics/painting/faculty/." ) {
  set req.http.x-redirect-location = "http://" req.http.host "/academics/painting/faculty/";
  error 301;
}
#--FASTLY RECV END



  if (req.request != "HEAD" && req.request != "GET" && req.request != "FASTLYPURGE") {
    return(pass);
  }


  return(lookup);
}

sub vcl_fetch {
#FASTLY fetch

  if ((beresp.status == 500 || beresp.status == 503) && req.restarts < 1 && (req.request == "GET" || req.request == "HEAD")) {
    restart;
  }

  if (req.restarts > 0) {
    set beresp.http.Fastly-Restarts = req.restarts;
  }

  if (beresp.http.Set-Cookie) {
    set req.http.Fastly-Cachetype = "SETCOOKIE";
    return(pass);
  }

  if (beresp.http.Cache-Control ~ "private") {
    set req.http.Fastly-Cachetype = "PRIVATE";
    return(pass);
  }

  if (beresp.status == 500 || beresp.status == 503) {
    set req.http.Fastly-Cachetype = "ERROR";
    set beresp.ttl = 1s;
    set beresp.grace = 5s;
    return(deliver);
  }

  if (beresp.http.Expires || beresp.http.Surrogate-Control ~ "max-age" || beresp.http.Cache-Control ~ "(s-maxage|max-age)") {
    # keep the ttl here
  } else {
    # apply the default ttl
    set beresp.ttl = 3600s;
  }

  return(deliver);
}

sub vcl_hit {
#FASTLY hit

  if (!obj.cacheable) {
    return(pass);
  }
  return(deliver);
}

sub vcl_miss {
#FASTLY miss
  return(fetch);
}

sub vcl_deliver {
#FASTLY deliver
  return(deliver);
}

sub vcl_error {
#FASTLY error

  # Snippet error_redirect_synthetic : 100
  if (obj.status == 301 && req.http.x-redirect-location) {
    set obj.http.Location = req.http.x-redirect-location;
    set obj.response = "Found";
    synthetic {""};
    return(deliver);
  }
}

sub vcl_pass {
#FASTLY pass
}

sub vcl_log {
#FASTLY log
}
